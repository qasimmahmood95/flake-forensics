import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Attempt, FinalOutcome, RunRecord, TestOccurrence } from './types.js';
import { compareTimestamps } from './util.js';

/**
 * Ingestion of Playwright JSON reports (`--reporter=json`).
 *
 * Hostile-input contract: a malformed report file NEVER aborts the batch —
 * it is skipped with a warning. Every array/object/string coming from a
 * report is type-checked before use, and suite recursion is depth-capped.
 *
 * Run metadata (commit, timestamp, CI run id) is resolved in this order:
 *   1. a sidecar file `<report>.meta.json` next to the report
 *      (what `flake-forensics fetch` writes)
 *   2. `config.metadata` keys: commit / gitCommit / ci.commit / ci.commitHash,
 *      timestamp, ciRunId / runId
 *   3. `stats.startTime` for the timestamp
 *   4. file mtime for the timestamp, file basename for the run id
 *      (a warning is emitted — trend analysis is only as good as the ordering)
 *
 * Reports that share a runId (e.g. per-shard JSON files inside one CI run's
 * artifact) are merged into a single run so n counts CI runs, not files.
 */

interface PwError {
  message?: unknown;
  stack?: unknown;
}

interface PwResult {
  status?: unknown;
  retry?: unknown;
  error?: PwError;
  errors?: unknown;
  startTime?: unknown;
}

interface PwTest {
  projectName?: unknown;
  status?: unknown;
  results?: unknown;
}

interface PwSpec {
  title?: unknown;
  file?: unknown;
  tests?: unknown;
}

interface PwSuite {
  title?: unknown;
  file?: unknown;
  suites?: unknown;
  specs?: unknown;
}

interface PwReport {
  config?: { metadata?: Record<string, unknown> };
  suites?: unknown;
  stats?: { startTime?: unknown };
}

export interface IngestResult {
  runs: RunRecord[];
  warnings: string[];
}

/** Guards against stack overflow on absurdly (or maliciously) nested suites. */
const MAX_SUITE_DEPTH = 100;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/**
 * Remove ASCII control characters (including ESC) from report-supplied text
 * so hostile titles cannot inject terminal escape sequences into CLI output.
 */
function sanitizeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
}

function attemptsFromResults(results: unknown): Attempt[] {
  if (!Array.isArray(results)) return [];
  return results
    .filter(isObject)
    .map((r) => r as PwResult)
    .sort((a, b) => (typeof a.retry === 'number' ? a.retry : 0) - (typeof b.retry === 'number' ? b.retry : 0))
    .map((r) => {
      const errorsArray = Array.isArray(r.errors) ? r.errors.filter(isObject) : [];
      const rawError = isObject(r.error) ? r.error : (errorsArray[0] as PwError | undefined);
      const attempt: Attempt = {
        status: typeof r.status === 'string' ? r.status : 'unknown',
        retry: typeof r.retry === 'number' ? r.retry : 0,
      };
      if (rawError !== undefined && typeof rawError.message === 'string') {
        attempt.error = { message: rawError.message };
        if (typeof rawError.stack === 'string') {
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
  // `interrupted` means the run was cancelled, not that the test failed.
  if (final.status === 'skipped' || final.status === 'interrupted') return 'skipped';
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
  suiteRaw: unknown,
  titles: string[],
  fileHint: string | undefined,
  depth: number,
  out: TestOccurrence[],
): void {
  if (!isObject(suiteRaw) || depth > MAX_SUITE_DEPTH) return;
  const suite = suiteRaw as PwSuite;
  const file = asString(suite.file) ?? fileHint;
  // Playwright's root suites are titled with the file path; skip those
  // titles so test ids do not repeat the file name.
  const ownTitle = asString(suite.title);
  const nextTitles =
    ownTitle !== undefined && ownTitle !== file ? [...titles, sanitizeText(ownTitle)] : titles;

  const specs = Array.isArray(suite.specs) ? suite.specs : [];
  for (const specRaw of specs) {
    if (!isObject(specRaw)) continue;
    const spec = specRaw as PwSpec;
    const specFile = asString(spec.file) ?? file ?? '<unknown-file>';
    const tests = Array.isArray(spec.tests) ? spec.tests : [];
    for (const testRaw of tests) {
      if (!isObject(testRaw)) continue;
      const test = testRaw as PwTest;
      const attempts = attemptsFromResults(test.results);
      const title = sanitizeText(
        [...nextTitles, asString(spec.title) ?? '<untitled>'].join(' › '),
      );
      const project = asString(test.projectName);
      out.push({
        testId: sanitizeText(
          `${project !== undefined ? `[${project}] ` : ''}${specFile} › ${title}`,
        ),
        file: specFile,
        title,
        outcome: outcomeFromTest(test, attempts),
        attempts,
      });
    }
  }
  const children = Array.isArray(suite.suites) ? suite.suites : [];
  for (const child of children) {
    collectTests(child, nextTitles, file, depth + 1, out);
  }
}

interface SidecarMeta {
  commit?: unknown;
  timestamp?: unknown;
  runId?: unknown;
}

async function readSidecar(reportFile: string): Promise<SidecarMeta | undefined> {
  const sidecarPath = reportFile.replace(/\.json$/, '.meta.json');
  try {
    const raw = await fs.readFile(sidecarPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? (parsed as SidecarMeta) : undefined;
  } catch {
    return undefined;
  }
}

export async function loadRun(
  reportFile: string,
  warnings: string[],
): Promise<RunRecord | undefined> {
  try {
    const raw = await fs.readFile(reportFile, 'utf8');
    // Windows tooling often prepends a UTF-8 BOM, which JSON.parse rejects.
    const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (!isObject(parsed)) {
      warnings.push(`${reportFile}: not a JSON object — not a Playwright JSON report; skipped`);
      return undefined;
    }
    const report = parsed as PwReport;
    if (!Array.isArray(report.suites)) {
      warnings.push(`${reportFile}: no "suites" array — not a Playwright JSON report; skipped`);
      return undefined;
    }

    const sidecar = await readSidecar(reportFile);
    const md = isObject(report.config?.metadata) ? report.config.metadata : {};
    const ci = isObject(md['ci']) ? md['ci'] : {};

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
      collectTests(suite, [], undefined, 0, tests);
    }

    return {
      runId: runId ?? path.basename(reportFile, '.json'),
      commit: commit !== undefined ? sanitizeText(commit) : 'unknown',
      timestamp,
      sourceFile: reportFile,
      tests,
    };
  } catch (err) {
    warnings.push(`${reportFile}: unreadable or malformed report (${(err as Error).message}); skipped`);
    return undefined;
  }
}

export async function loadRuns(reportFiles: string[]): Promise<IngestResult> {
  const warnings: string[] = [];
  const loaded: RunRecord[] = [];
  for (const file of reportFiles) {
    const run = await loadRun(file, warnings);
    if (run !== undefined) loaded.push(run);
  }

  // Merge reports that belong to the same CI run (same runId), e.g. one
  // JSON file per shard inside a single artifact. Without this, n would
  // count files instead of runs.
  const byRunId = new Map<string, RunRecord>();
  for (const run of loaded) {
    const existing = byRunId.get(run.runId);
    if (existing === undefined) {
      byRunId.set(run.runId, run);
      continue;
    }
    existing.tests.push(...run.tests);
    if (compareTimestamps(run.timestamp, existing.timestamp) < 0) {
      existing.timestamp = run.timestamp;
    }
    if (existing.commit === 'unknown') {
      existing.commit = run.commit;
    } else if (run.commit !== 'unknown' && run.commit !== existing.commit) {
      warnings.push(
        `run ${run.runId}: reports disagree on commit (${existing.commit} vs ${run.commit}); keeping ${existing.commit}`,
      );
    }
  }

  const runs = [...byRunId.values()].sort((a, b) => compareTimestamps(a.timestamp, b.timestamp));
  return { runs, warnings };
}
