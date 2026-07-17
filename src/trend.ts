import { twoProportionTest } from './stats.js';

/**
 * Simple single-changepoint detection over a per-run Bernoulli series
 * (disrupted / not disrupted), ordered by time.
 *
 * Method: try every split point with at least `minSegment` runs on each
 * side, keep the split with the largest |z| from a pooled two-proportion
 * test, and report it only if it clears BOTH a significance bar and a
 * minimum effect size. This is deliberately blunt: it flags "this test's
 * behaviour changed around here", it does not prove which commit caused it.
 */

export interface TrendPoint {
  disrupted: boolean;
  runId: string;
  commit: string;
  timestamp: string;
}

export interface Changepoint {
  /** Index of the first run of the "after" segment. */
  index: number;
  runId: string;
  commit: string;
  timestamp: string;
  before: { rate: number; n: number };
  after: { rate: number; n: number };
  direction: 'improved' | 'worsened';
  pValue: number;
}

export interface TrendOptions {
  /** Minimum runs on each side of a candidate split. Default 5. */
  minSegment: number;
  /** Significance bar. Default 0.01 — strict, because we scan many splits. */
  alpha: number;
  /** Minimum absolute rate change to bother reporting. Default 0.2. */
  minDelta: number;
  /**
   * The busier segment must contain at least this many disrupted runs.
   * Default 3: the pooled z-test is unreliable at tiny counts, and a
   * "changepoint" inferred from one or two events is an anecdote.
   */
  minDisruptions: number;
}

export const DEFAULT_TREND_OPTIONS: TrendOptions = {
  minSegment: 5,
  alpha: 0.01,
  minDelta: 0.2,
  minDisruptions: 3,
};

export function detectChangepoint(
  series: TrendPoint[],
  options: TrendOptions = DEFAULT_TREND_OPTIONS,
): Changepoint | undefined {
  const n = series.length;
  if (n < options.minSegment * 2) return undefined;

  // Prefix sums of disruptions for O(n) rate lookups.
  const prefix: number[] = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = (prefix[i] ?? 0) + (series[i]?.disrupted === true ? 1 : 0);
  }
  const total = prefix[n] ?? 0;

  let best: { index: number; absZ: number; pValue: number } | undefined;
  for (let i = options.minSegment; i <= n - options.minSegment; i++) {
    const k1 = prefix[i] ?? 0;
    const k2 = total - k1;
    const { z, pValue } = twoProportionTest(k1, i, k2, n - i);
    const absZ = Math.abs(z);
    if (best === undefined || absZ > best.absZ) {
      best = { index: i, absZ, pValue };
    }
  }
  if (best === undefined) return undefined;

  const i = best.index;
  const k1 = prefix[i] ?? 0;
  const k2 = total - k1;
  const before = { rate: k1 / i, n: i };
  const after = { rate: k2 / (n - i), n: n - i };
  const delta = after.rate - before.rate;

  if (best.pValue >= options.alpha || Math.abs(delta) < options.minDelta) {
    return undefined;
  }
  if (Math.max(k1, k2) < options.minDisruptions) {
    return undefined;
  }

  const splitPoint = series[i];
  if (splitPoint === undefined) return undefined;
  return {
    index: i,
    runId: splitPoint.runId,
    commit: splitPoint.commit,
    timestamp: splitPoint.timestamp,
    before,
    after,
    direction: delta < 0 ? 'improved' : 'worsened',
    pValue: best.pValue,
  };
}
