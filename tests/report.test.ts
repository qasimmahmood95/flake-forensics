import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { renderHtml } from '../src/report/html.js';
import { renderQuarantineMd } from '../src/report/quarantineMd.js';
import type { RunRecord, FinalOutcome } from '../src/types.js';

function runsWith(testId: string, commit: string, outcomes: FinalOutcome[]): RunRecord[] {
  return outcomes.map((outcome, i) => ({
    runId: `run-${i}`,
    commit,
    timestamp: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
    sourceFile: `run-${i}.json`,
    tests: [
      {
        testId,
        file: 'x.spec.ts',
        title: testId,
        outcome,
        attempts:
          outcome === 'rescued'
            ? [
                {
                  status: 'failed',
                  retry: 0,
                  error: { message: 'Error: boom', stack: 'Error: boom\n    at f (/repo/tests/a.ts:1:1)' },
                },
                { status: 'passed', retry: 1 },
              ]
            : [{ status: outcome === 'failed' ? 'failed' : 'passed', retry: 0 }],
      },
    ],
  }));
}

describe('renderHtml', () => {
  it('escapes hostile commit metadata everywhere it appears', () => {
    const payload = '"><img src=x onerror=alert(1)>';
    const outcomes: FinalOutcome[] = Array.from({ length: 20 }, (_, i) =>
      i % 4 === 0 ? 'rescued' : 'passed',
    );
    const analysis = analyze(runsWith('t', payload, outcomes));
    const html = renderHtml(analysis);
    // The raw payload must never appear outside the <-escaped JSON blob.
    expect(html).not.toContain('"><img');
  });

  it('escapes hostile test ids', () => {
    const analysis = analyze(runsWith('<script>alert(1)</script>', 'abc', Array(12).fill('passed') as FinalOutcome[]));
    const html = renderHtml(analysis);
    expect(html).not.toContain('<script>alert(1)');
  });
});

describe('renderQuarantineMd', () => {
  it('keeps code spans intact when test titles contain backticks', () => {
    const testId = 'suite › runs `rm -rf` safely';
    const outcomes: FinalOutcome[] = Array.from({ length: 40 }, (_, i) =>
      i % 4 === 0 ? 'rescued' : 'passed',
    );
    const analysis = analyze(runsWith(testId, 'abc', outcomes));
    const md = renderQuarantineMd(analysis);
    expect(md).toContain('`` suite › runs `rm -rf` safely ``');
    expect(md).not.toContain('``` '); // no accidental triple-backtick fences
  });
});
