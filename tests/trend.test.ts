import { describe, expect, it } from 'vitest';
import { detectChangepoint, type TrendPoint } from '../src/trend.js';

function series(pattern: string): TrendPoint[] {
  // '1' = disrupted run, '0' = clean run
  return [...pattern].map((ch, i) => ({
    disrupted: ch === '1',
    runId: `run-${i}`,
    commit: `commit-${i}`,
    timestamp: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
  }));
}

describe('detectChangepoint', () => {
  it('finds an improvement and points at the first clean-era run', () => {
    const s = series('1101101011'.repeat(2) + '0'.repeat(20)); // 20 bad, 20 clean
    const cp = detectChangepoint(s);
    expect(cp).toBeDefined();
    expect(cp?.direction).toBe('improved');
    expect(cp?.index).toBeGreaterThanOrEqual(18);
    expect(cp?.index).toBeLessThanOrEqual(22);
    expect(cp?.before.rate).toBeGreaterThan(0.5);
    expect(cp?.after.rate).toBeLessThan(0.1);
  });

  it('finds a regression', () => {
    const s = series('0'.repeat(25) + '1101110111'.repeat(2));
    const cp = detectChangepoint(s);
    expect(cp).toBeDefined();
    expect(cp?.direction).toBe('worsened');
  });

  it('reports the commit at the split point', () => {
    const s = series('1'.repeat(10) + '0'.repeat(10));
    const cp = detectChangepoint(s);
    expect(cp?.commit).toBe(`commit-${cp?.index}`);
  });

  it('stays silent on a flat healthy series', () => {
    expect(detectChangepoint(series('0'.repeat(50)))).toBeUndefined();
  });

  it('stays silent on a flat noisy series', () => {
    expect(detectChangepoint(series('0100100100'.repeat(5)))).toBeUndefined();
  });

  it('stays silent below twice the minimum segment size', () => {
    expect(detectChangepoint(series('111100000'))).toBeUndefined(); // n = 9 < 10
  });

  it('never infers a changepoint from a single event', () => {
    // One disrupted run near the end: the pooled z-test alone would fire
    // (0/45 vs 1/5, p ≈ 0.002) but one event is an anecdote, not a trend.
    const s = series('0'.repeat(45) + '10000');
    expect(detectChangepoint(s)).toBeUndefined();
  });

  it('ignores changes smaller than the minimum effect size', () => {
    // 0/65 -> 6/35 (~17%): the best split is significant (p ≈ 6e-4) but the
    // rate change never reaches the 0.2 minDelta bar at any split.
    const s = series('0'.repeat(65) + '00001'.repeat(6) + '00000');
    expect(detectChangepoint(s)).toBeUndefined();
  });
});
