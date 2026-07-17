import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRuns } from '../src/ingest.js';

let dir: string;

function report(overrides: {
  metadata?: Record<string, unknown>;
  /** Pass null to omit the status field entirely. */
  status?: string | null;
  results?: object[];
}): object {
  return {
    config: { metadata: overrides.metadata ?? { commit: 'abc123', ciRunId: 'run-1', timestamp: '2026-05-01T03:00:00.000Z' } },
    suites: [
      {
        title: 'cart.spec.ts',
        file: 'cart.spec.ts',
        suites: [
          {
            title: 'checkout',
            file: 'cart.spec.ts',
            specs: [
              {
                title: 'applies discount',
                file: 'cart.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    ...(overrides.status === null ? {} : { status: overrides.status ?? 'expected' }),
                    results: overrides.results ?? [{ status: 'passed', retry: 0 }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    stats: { startTime: '2026-05-01T03:00:00.000Z' },
  };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'flake-forensics-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadRuns', () => {
  it('builds test ids from project, file and title path without repeating the file suite', async () => {
    const file = path.join(dir, 'a.json');
    await writeFile(file, JSON.stringify(report({})));
    const { runs } = await loadRuns([file]);
    expect(runs[0]?.tests[0]?.testId).toBe('[chromium] cart.spec.ts › checkout › applies discount');
  });

  it('maps flaky (failed-then-passed) to rescued', async () => {
    const file = path.join(dir, 'b.json');
    await writeFile(
      file,
      JSON.stringify(
        report({
          status: 'flaky',
          results: [
            { status: 'failed', retry: 0, error: { message: 'boom', stack: 'Error: boom\n    at f (/repo/tests/a.ts:1:1)' } },
            { status: 'passed', retry: 1 },
          ],
        }),
      ),
    );
    const { runs } = await loadRuns([file]);
    expect(runs[0]?.tests[0]?.outcome).toBe('rescued');
  });

  it('derives rescued from attempts when the status field is missing', async () => {
    const file = path.join(dir, 'c.json');
    await writeFile(
      file,
      JSON.stringify(
        report({
          status: null,
          results: [
            { status: 'timedOut', retry: 0, error: { message: 'slow' } },
            { status: 'passed', retry: 1 },
          ],
        }),
      ),
    );
    const { runs } = await loadRuns([file]);
    expect(runs[0]?.tests[0]?.outcome).toBe('rescued');
  });

  it('reads metadata from the report and prefers the sidecar when present', async () => {
    const file = path.join(dir, 'd.json');
    await writeFile(file, JSON.stringify(report({})));
    await writeFile(
      file.replace(/\.json$/, '.meta.json'),
      JSON.stringify({ commit: 'sidecar-sha', runId: 'sidecar-run', timestamp: '2026-06-01T00:00:00.000Z' }),
    );
    const { runs } = await loadRuns([file]);
    expect(runs[0]?.commit).toBe('sidecar-sha');
    expect(runs[0]?.runId).toBe('sidecar-run');
    expect(runs[0]?.timestamp).toBe('2026-06-01T00:00:00.000Z');
  });

  it('warns and skips files that are not Playwright reports', async () => {
    const file = path.join(dir, 'e.json');
    await writeFile(file, JSON.stringify({ hello: 'world' }));
    const { runs, warnings } = await loadRuns([file]);
    expect(runs).toHaveLength(0);
    expect(warnings.some((w) => w.includes('not a Playwright JSON report'))).toBe(true);
  });

  it('sorts runs by timestamp', async () => {
    const early = path.join(dir, 'f1.json');
    const late = path.join(dir, 'f2.json');
    await writeFile(late, JSON.stringify(report({ metadata: { commit: 'x', ciRunId: 'late', timestamp: '2026-05-02T00:00:00.000Z' } })));
    await writeFile(early, JSON.stringify(report({ metadata: { commit: 'x', ciRunId: 'early', timestamp: '2026-05-01T00:00:00.000Z' } })));
    const { runs } = await loadRuns([late, early]);
    expect(runs.map((r) => r.runId)).toEqual(['early', 'late']);
  });
});
