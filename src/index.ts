#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { resolveInputs } from './fsglob.js';
import { loadRuns } from './ingest.js';
import { analyze } from './analyze.js';
import { validateThresholds, type Thresholds } from './classify.js';
import { renderTable, renderSummary, type SortKey } from './report/table.js';
import { renderQuarantineMd } from './report/quarantineMd.js';
import { renderHtml } from './report/html.js';
import { fetchArtifacts } from './fetch.js';

const program = new Command();

function intOption(min: number) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) {
      throw new InvalidArgumentError(`must be an integer >= ${min}`);
    }
    return n;
  };
}

program
  .name('flake-forensics')
  .description('Statistically honest flake analysis for Playwright JSON reports across CI runs')
  .version('0.1.0');

program
  .command('analyze')
  .description('Analyse a directory (or glob) of Playwright JSON reports')
  .argument('<inputs...>', 'report directories, files, or glob patterns')
  .option('--json <file>', 'write full machine-readable analysis as JSON')
  .option('--html <file>', 'write a single-file static HTML report')
  .option('--quarantine <file>', 'write a quarantine.md proposal')
  .option('--sort <key>', 'table sort: state | disruption | fail | rescue | name', 'state')
  .option('--limit <n>', 'show at most N table rows', intOption(1))
  .option('--min-runs <n>', 'minimum runs before classifying (default 10)', intOption(1))
  .option('--config <file>', 'JSON file overriding any threshold (see README)')
  .option('--quiet', 'suppress the table; print only the summary')
  .action(
    async (
      inputs: string[],
      opts: {
        json?: string;
        html?: string;
        quarantine?: string;
        sort: string;
        limit?: number;
        minRuns?: number;
        config?: string;
        quiet?: boolean;
      },
    ) => {
      const files = await resolveInputs(inputs);
      if (files.length === 0) {
        program.error(`no report files found for: ${inputs.join(', ')}`);
      }

      // Fail fast on unusable output paths instead of after the analysis.
      for (const out of [opts.json, opts.html, opts.quarantine]) {
        if (out === undefined) continue;
        const stat = await fs.stat(out).catch(() => undefined);
        if (stat?.isDirectory() === true) {
          program.error(`output path is a directory: ${out}`);
        }
      }

      let thresholds: Partial<Thresholds> = {};
      if (opts.config !== undefined) {
        try {
          thresholds = validateThresholds(JSON.parse(await fs.readFile(opts.config, 'utf8')));
        } catch (err) {
          program.error(`invalid --config ${opts.config}: ${(err as Error).message}`);
        }
      }
      if (opts.minRuns !== undefined) thresholds.minRuns = opts.minRuns;

      const { runs, warnings } = await loadRuns(files);
      if (runs.length === 0) {
        program.error(`found ${files.length} file(s) but none parsed as Playwright JSON reports`);
      }
      const analysis = analyze(runs, { thresholds, warnings });

      if (opts.quiet !== true) {
        const sortKey = (['state', 'disruption', 'fail', 'rescue', 'name'] as const).includes(
          opts.sort as SortKey,
        )
          ? (opts.sort as SortKey)
          : 'state';
        console.log(renderTable(analysis, sortKey, opts.limit));
        console.log('');
      }
      console.log(renderSummary(analysis));

      const outputs: Array<[string | undefined, () => string]> = [
        [opts.json, () => JSON.stringify(analysis, null, 2)],
        [opts.html, () => renderHtml(analysis)],
        [opts.quarantine, () => renderQuarantineMd(analysis)],
      ];
      for (const [file, render] of outputs) {
        if (file === undefined) continue;
        await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
        await fs.writeFile(file, render(), 'utf8');
        console.log(`wrote ${file}`);
      }
    },
  );

program
  .command('fetch')
  .description('Pull Playwright JSON report artifacts from GitHub Actions (optional helper)')
  .requiredOption('--repo <owner/name>', 'GitHub repository')
  .requiredOption('--workflow <file>', 'workflow file name, e.g. ci.yml')
  .option('--artifact <name>', 'artifact name to download', 'playwright-report')
  .option('--out <dir>', 'output directory', 'reports')
  .option('--runs <n>', 'number of recent completed runs to fetch', (v) => Number.parseInt(v, 10), 50)
  .option('--token <token>', 'GitHub token (defaults to GITHUB_TOKEN env var)')
  .action(
    async (opts: {
      repo: string;
      workflow: string;
      artifact: string;
      out: string;
      runs: number;
      token?: string;
    }) => {
      const token = opts.token ?? process.env['GITHUB_TOKEN'] ?? '';
      if (token.length === 0) {
        program.error('a GitHub token is required: pass --token or set GITHUB_TOKEN');
      }
      const { reportsWritten } = await fetchArtifacts({
        repo: opts.repo,
        workflow: opts.workflow,
        artifact: opts.artifact,
        outDir: opts.out,
        limit: opts.runs,
        token,
        log: (message) => console.log(message),
      });
      console.log(`Done: ${reportsWritten} report file(s) written to ${opts.out}`);
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
