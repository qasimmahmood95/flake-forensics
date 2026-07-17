import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Attempt, FinalOutcome, RunRecord, TestOccurrence } from './types.js';

/**
 * Ingestion of Playwright JSON reports (`--reporter=json`).
 *
 * Run metadata (commit, timestamp, CI run id) is resolved in this order:
 *   1. a sidecar file `<report>.meta.json` next to the report
 *      (what `flake-forensics fetch` writes)
 *   2. `config.metadata` keys: commit / gitCommit / ci.commit / ci.commitHash,
 *      timestamp, ciRunId / runId
 *   3. `stats.startTime` for the timestamp
 *   4. file mtime for the timestamp, file basename for the run id
 *      (a warning is emitted — trend analysis is only as good as the ordering)
 */

interface PwError {
  message?: string;
  stack?: string;
}

interface PwResult {
  status?: string;
  retry?: number;
  error?: PwError;
  errors?: PwError[];
  startTime?: string;
}

interface PwTest {
  projectName?: string;
  status?: string;
  expectedStatus?: string;
  results?: PwResult[];
}

interface PwSpec {
  title?: string;
  file?: string;
  tests?: PwTest[];
}

interface PwSuite {
  title?: string;
  file?: string;
  suites?: PwSuite[];
  specs?: PwSpec[];
}

interface PwReport {
  config?: { metadata?: Record<string, unknown> };
  suites?: PwSuite[];
  stats?: { startTime?: string };
}

export interface IngestResult {
  runs: RunRecord[];
  warnings: string[];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    const s = asString(v);
    if (s !== undefined) return s;
  }
  return undefined;
}

function attemptsFromResults(results: PwResult[]): Attempt[] {
  return [...results]
    .sort((a, b) => (a.retry ?? 0) - (b.retry ?? 0))
    .map((r) => {
      const rawError = r.error ?? r.errors?.[0];
      const attempt: Attempt = {
        status: r.status ?? 'unknown',
        retry: r.retry ?? 0,
      };
      if (rawError?.message !== undefined) {
        attempt.error = { message: rawError.message };
        if (rawError.stack !== undefined) {
          attempt.error.stack = rawError.stack;
        }
      }
      return attempt;
    });
}

function outcomeFromAttempts(attempts: Attempt[]): FinalOutcome {
  if (attempts.length === 0) return 'skipped';
  const final = attempts[attempts.length - 1];
  if (final === undefined) return 'skipped';
  if (final.status === 'passed') {
    const earlierFailure = attempts.some(
      (a) => a !== final && (a.status === 'failed' || a.status === 'timedOut'),
    );
    return earlierFailure ? 'rescued' : 'passed';
  }
  if (final.status === 'skipped') return 'skipped';
  return 'failed';
}

/**
 * Playwright's own verdict (`expected` / `unexpected` / `flaky` / `skipped`)
 * is used when present because it accounts for `expectedStatus` (test.fail()
 * etc.); the per-attempt derivation is the fallback.
 */
function outcomeFromTest(test: PwTest, attempts: Attempt[]): FinalOutcome {
  switch (test.status) {
    case 'expected':
      return 'passed';
    case 'flaky':
      return 'rescued';
    case 'unexpected':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return outcomeFromAttempts(attempts);
  }
}

function collectTests(
  suite: PwSuite,
  titles: string[],
  fileHint: string | undefined,
  out: TestOccurrence[],
): void {
  const file = suite.file ?? fileHint;
  // Playwright's root suites are titled with the file path; skip those
  // titles so test ids do not repeat the file name.
  const ownTitle = suite.title;
  const nextTitles =
    ownTitle !== undefined && ownTitle.length > 0 && ownTitle !== file
      ? [...titles, ownTitle]
      : titles;

  for (const spec of suite.specs ?? []) {
    const specFile = spec.file ?? file ?? '<unknown-file>';
    for (const test of spec.tests ?? []) {
      const attempts = attemptsFromResults(test.results ?? []);
      const title = [...nextTitles, spec.title ?? '<untitled>'].join(' › ');
      const project = asString(test.projectName);
      out.push({
        testId: `${project !== undefined ? `[${project}] ` : ''}${specFile} › ${title}`,
        file: specFile,
        title,
        outcome: outcomeFromTest(test, attempts),
        attempts,
      });
    }
  }
  for (const child of suite.suites ?? []) {
    collectTests(child, nextTitles, file, out);
  }
}

interface SidecarMeta {
  commit?: string;
  timestamp?: string;
  runId?: string;
}

async function readSidecar(reportFile: string): Promise<SidecarMeta | undefined> {
  const sidecarPath = reportFile.replace(/\.json$/, '.meta.json');
  try {
    const raw = await fs.readFile(sidecarPath, 'utf8');
    return JSON.parse(raw) as SidecarMeta;
  } catch {
    return undefined;
  }
}

export async function loadRun(
  reportFile: string,
  warnings: string[],
): Promise<RunRecord | undefined> {
  let report: PwReport;
  try {
    report = JSON.parse(await fs.readFile(reportFile, 'utf8')) as PwReport;
  } catch (err) {
    warnings.push(`${reportFile}: unreadable or invalid JSON (${(err as Error).message})`);
    return undefined;
  }
  if (!Array.isArray(report.suites)) {
    warnings.push(`${reportFile}: no "suites" array — not a Playwright JSON report; skipped`);
    return undefined;
  }

  const sidecar = await readSidecar(reportFile);
  const md = report.config?.metadata ?? {};
  const ci = (md['ci'] ?? {}) as Record<string, unknown>;

  const commit = firstString(sidecar?.commit, md['commit'], md['gitCommit'], ci['commit'], ci['commitHash']);
  let timestamp = firstString(sidecar?.timestamp, md['timestamp'], report.stats?.startTime);
  const runId = firstString(sidecar?.runId, md['ciRunId'], md['runId'], ci['runId']);

  if (timestamp === undefined) {
    const stat = await fs.stat(reportFile);
    timestamp = stat.mtime.toISOString();
    warnings.push(`${reportFile}: no timestamp in metadata; falling back to file mtime (trend ordering may be wrong)`);
  }
  if (commit === undefined) {
    warnings.push(`${reportFile}: no commit in metadata; changepoints for this run cannot name a commit`);
  }

  const tests: TestOccurrence[] = [];
  for (const suite of report.suites) {
    collectTests(suite, [], undefined, tests);
  }

  return {
    runId: runId ?? path.basename(reportFile, '.json'),
    commit: commit ?? 'unknown',
    timestamp,
    sourceFile: reportFile,
    tests,
  };
}

export async function loadRuns(reportFiles: string[]): Promise<IngestResult> {
  const warnings: string[] = [];
  const runs: RunRecord[] = [];
  for (const file of reportFiles) {
    const run = await loadRun(file, warnings);
    if (run !== undefined) runs.push(run);
  }
  runs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { runs, warnings };
}
