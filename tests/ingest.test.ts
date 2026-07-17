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

  it('skips a file whose entire content is null, without aborting the batch', async () => {
    const nullFile = path.join(dir, 'null.json');
    const goodFile = path.join(dir, 'good-next-to-null.json');
    await writeFile(nullFile, 'null');
    await writeFile(goodFile, JSON.stringify(report({})));
    const { runs, warnings } = await loadRuns([nullFile, goodFile]);
    expect(runs).toHaveLength(1);
    expect(warnings.some((w) => w.includes('null.json'))).toBe(true);
  });

  it('survives hostile structure: null suites, non-array results, junk elements', async () => {
    const file = path.join(dir, 'hostile.json');
    await writeFile(
      file,
      JSON.stringify({
        suites: [
          null,
          42,
          { title: 'x.spec.ts', file: 'x.spec.ts', specs: [null, { title: 't', tests: [{ results: { not: 'array' } }, null] }] },
        ],
      }),
    );
    const { runs } = await loadRuns([file]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.tests).toHaveLength(1); // the one salvageable test, as skipped
    expect(runs[0]?.tests[0]?.outcome).toBe('skipped');
  });

  it('ignores non-string error messages instead of crashing later', async () => {
    const file = path.join(dir, 'badmsg.json');
    await writeFile(
      file,
      JSON.stringify(
        report({
          status: 'unexpected',
          results: [{ status: 'failed', retry: 0, error: { message: 42, stack: ['not', 'a', 'string'] } }],
        }),
      ),
    );
    const { runs } = await loadRuns([file]);
    const test = runs[0]?.tests[0];
    expect(test?.outcome).toBe('failed');
    expect(test?.attempts[0]?.error).toBeUndefined();
  });

  it('caps suite recursion depth instead of overflowing the stack', async () => {
    // Depth 1000 is far above the ingest cap (100) but shallow enough that
    // building/parsing the JSON itself is safe on every runner's stack.
    let nested: object = {
      title: 'deep.spec.ts',
      specs: [{ title: 'buried', tests: [{ results: [{ status: 'passed', retry: 0 }] }] }],
    };
    for (let i = 0; i < 1000; i++) nested = { title: 's', suites: [nested] };
    const file = path.join(dir, 'deep.json');
    await writeFile(file, JSON.stringify({ suites: [nested] }));
    const { runs } = await loadRuns([file]);
    expect(runs).toHaveLength(1); // no crash
    expect(runs[0]?.tests).toHaveLength(0); // nothing salvaged below the cap
  });

  it('maps interrupted (cancelled run) to skipped, not failed', async () => {
    const file = path.join(dir, 'interrupted.json');
    await writeFile(
      file,
      JSON.stringify(report({ status: null, results: [{ status: 'interrupted', retry: 0 }] })),
    );
    const { runs } = await loadRuns([file]);
    expect(runs[0]?.tests[0]?.outcome).toBe('skipped');
  });

  it('merges reports sharing a runId (sharded artifacts) into one run', async () => {
    const shard1 = path.join(dir, 'shard1.json');
    const shard2 = path.join(dir, 'shard2.json');
    const meta = { commit: 'abc123', ciRunId: 'gha-777', timestamp: '2026-05-01T03:00:00.000Z' };
    await writeFile(shard1, JSON.stringify(report({ metadata: meta })));
    await writeFile(shard2, JSON.stringify(report({ metadata: meta })));
    const { runs } = await loadRuns([shard1, shard2]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.tests).toHaveLength(2); // same test from both shards, deduped later by analyze
  });

  it('strips control characters from titles (terminal escape injection)', async () => {
    const esc = String.fromCharCode(0x1b);
    const file = path.join(dir, 'ansi.json');
    const raw = JSON.parse(JSON.stringify(report({}))) as {
      suites: Array<{ suites: Array<{ specs: Array<{ title: string }> }> }>;
    };
    raw.suites[0]!.suites[0]!.specs[0]!.title = `evil${esc}[2Jtitle`;
    await writeFile(file, JSON.stringify(raw));
    const { runs } = await loadRuns([file]);
    expect(runs[0]?.tests[0]?.testId).not.toContain(esc);
  });

  it('accepts reports with a UTF-8 BOM', async () => {
    const file = path.join(dir, 'bom.json');
    const bom = String.fromCharCode(0xfeff);
    await writeFile(file, `${bom}${JSON.stringify(report({}))}`);
    const { runs, warnings } = await loadRuns([file]);
    expect(runs).toHaveLength(1);
    expect(warnings).toHaveLength(0);
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
