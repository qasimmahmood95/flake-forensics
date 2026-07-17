import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import type { RunRecord, TestOccurrence, FinalOutcome } from '../src/types.js';

function occurrence(testId: string, outcome: FinalOutcome, errorMessage?: string): TestOccurrence {
  const attempts =
    outcome === 'failed'
      ? [
          {
            status: 'failed',
            retry: 0,
            error: {
              message: errorMessage ?? 'Error: boom',
              stack: `${errorMessage ?? 'Error: boom'}\n    at helper (/repo/tests/helpers/api.ts:17:3)`,
            },
          },
        ]
      : outcome === 'rescued'
        ? [
            {
              status: 'failed',
              retry: 0,
              error: {
                message: errorMessage ?? 'Error: boom',
                stack: `${errorMessage ?? 'Error: boom'}\n    at helper (/repo/tests/helpers/api.ts:17:3)`,
              },
            },
            { status: 'passed', retry: 1 },
          ]
        : [{ status: outcome === 'skipped' ? 'skipped' : 'passed', retry: 0 }];
  return { testId, file: 'x.spec.ts', title: testId, outcome, attempts };
}

function makeRuns(perRunOutcomes: Array<Record<string, FinalOutcome>>): RunRecord[] {
  return perRunOutcomes.map((tests, i) => ({
    runId: `run-${i}`,
    commit: `commit-${i}`,
    timestamp: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
    sourceFile: `run-${i}.json`,
    tests: Object.entries(tests).map(([id, outcome]) => occurrence(id, outcome)),
  }));
}

describe('analyze', () => {
  it('excludes skipped runs from n', () => {
    const runs = makeRuns(
      Array.from({ length: 20 }, (_, i) => ({ t: (i < 5 ? 'skipped' : 'passed') as FinalOutcome })),
    );
    const analysis = analyze(runs);
    expect(analysis.tests[0]?.n).toBe(15);
  });

  it('flags an environment-wide cluster when one signature spans many tests', () => {
    const runs = makeRuns(
      Array.from({ length: 12 }, (_, i) => {
        const down = i === 5 || i === 6;
        return {
          a: (down ? 'failed' : 'passed') as FinalOutcome,
          b: (down ? 'failed' : 'passed') as FinalOutcome,
          c: (down ? 'failed' : 'passed') as FinalOutcome,
        };
      }),
    );
    // Same message shape, different ports — must normalise to one cluster.
    for (const run of runs) {
      for (const test of run.tests) {
        const attempt = test.attempts[0];
        if (attempt?.error !== undefined) {
          const port = 30000 + Math.floor(Math.random() * 1000);
          attempt.error.message = `Error: connect ECONNREFUSED 127.0.0.1:${port}`;
          attempt.error.stack = `${attempt.error.message}\n    at helper (/repo/tests/helpers/api.ts:17:3)`;
        }
      }
    }
    const analysis = analyze(runs);
    const envWide = analysis.clusters.filter((c) => c.envWide);
    expect(envWide).toHaveLength(1);
    expect(envWide[0]?.testIds).toEqual(['a', 'b', 'c']);
  });

  it('routes FAILING tests to "fix", not "quarantine"', () => {
    const runs = makeRuns(Array.from({ length: 20 }, () => ({ broken: 'failed' as FinalOutcome })));
    const analysis = analyze(runs);
    expect(analysis.tests[0]?.classification.state).toBe('FAILING');
    const rec = analysis.quarantine.find((q) => q.testId === 'broken');
    expect(rec?.action).toBe('fix');
    expect(rec?.expiry).toBeUndefined();
  });

  it('quarantines a confident flake with an expiry date', () => {
    const runs = makeRuns(
      Array.from({ length: 40 }, (_, i) => ({ shaky: (i % 4 === 0 ? 'rescued' : 'passed') as FinalOutcome })),
    );
    const now = new Date('2026-07-17T00:00:00.000Z');
    const analysis = analyze(runs, { now });
    const rec = analysis.quarantine.find((q) => q.testId === 'shaky');
    expect(rec?.action).toBe('quarantine');
    expect(rec?.expiry).toBe('2026-08-16');
    expect(rec?.evidence).toContain('95% CI');
  });

  it('does not quarantine a test that improved after a changepoint', () => {
    const runs = makeRuns(
      Array.from({ length: 40 }, (_, i) => ({ fixed: (i < 20 ? 'failed' : 'passed') as FinalOutcome })),
    );
    const analysis = analyze(runs);
    const test = analysis.tests.find((t) => t.testId === 'fixed');
    expect(test?.changepoint?.direction).toBe('improved');
    expect(test?.recent?.state).toBe('HEALTHY');
    const rec = analysis.quarantine.find((q) => q.testId === 'fixed');
    expect(rec?.action).toBe('monitor');
    expect(rec?.evidence).toContain('Improved since commit');
  });

  it('monitors (not quarantines) a test that is clean since the fix but with a short window', () => {
    // 23 failing runs, then 7 clean: changepoint improved, but the after
    // window is below minRuns — still must not quarantine.
    const runs = makeRuns(
      Array.from({ length: 30 }, (_, i) => ({ justFixed: (i < 23 ? 'failed' : 'passed') as FinalOutcome })),
    );
    const analysis = analyze(runs);
    const test = analysis.tests.find((t) => t.testId === 'justFixed');
    expect(test?.changepoint?.direction).toBe('improved');
    expect(test?.recent?.state).toBe('TOO_FEW_RUNS');
    const rec = analysis.quarantine.find((q) => q.testId === 'justFixed');
    expect(rec?.action).toBe('monitor');
    expect(rec?.evidence).toContain('Clean since commit');
  });

  it('does not feed expected failures (test.fail() attempts) into clusters', () => {
    // Outcome "passed" despite failed attempts — Playwright's `expected`
    // verdict for test.fail(). Events from these must not create clusters.
    const runs = makeRuns(Array.from({ length: 12 }, () => ({ t: 'passed' as FinalOutcome })));
    for (const run of runs) {
      const test = run.tests[0]!;
      test.attempts = [
        {
          status: 'failed',
          retry: 0,
          error: { message: 'Error: boom', stack: 'Error: boom\n    at f (/repo/tests/a.ts:1:1)' },
        },
      ];
    }
    const analysis = analyze(runs);
    expect(analysis.clusters).toHaveLength(0);
    expect(analysis.tests[0]?.classification.state).toBe('HEALTHY');
  });

  it('attributes env-wide failures instead of quarantining each test', () => {
    // 3 tests, each disrupted only during a 6-run outage window out of 40:
    // individually FLAKY with a lower bound above the quarantine bar, but all
    // failures share one env-wide signature -> monitor.
    const runs = makeRuns(
      Array.from({ length: 40 }, (_, i) => {
        const down = i >= 20 && i < 26;
        return {
          a: (down ? 'failed' : 'passed') as FinalOutcome,
          b: (down ? 'failed' : 'passed') as FinalOutcome,
          c: (down ? 'failed' : 'passed') as FinalOutcome,
        };
      }),
    );
    const analysis = analyze(runs);
    for (const id of ['a', 'b', 'c']) {
      const rec = analysis.quarantine.find((q) => q.testId === id);
      expect(rec?.action).toBe('monitor');
      expect(rec?.evidence).toContain('environment-wide');
    }
  });
});
