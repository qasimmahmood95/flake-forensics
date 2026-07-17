/**
 * Statistical primitives. Everything the tool claims about a rate goes
 * through here so that every number carries its sample size and interval.
 */

/** Two-sided 95% critical value of the standard normal distribution. */
export const Z95 = 1.959963984540054;

export interface WilsonInterval {
  /** Point estimate successes / n. */
  rate: number;
  /** Lower bound of the score interval. */
  lower: number;
  /** Upper bound of the score interval. */
  upper: number;
  n: number;
  successes: number;
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * Chosen over the naive Wald interval because it behaves sensibly at the
 * extremes that dominate flake data: k = 0 and k = n still produce a
 * non-degenerate interval, and coverage stays close to nominal at small n.
 */
export function wilson(successes: number, n: number, z: number = Z95): WilsonInterval {
  if (!Number.isInteger(successes) || !Number.isInteger(n)) {
    throw new RangeError('wilson(): successes and n must be integers');
  }
  if (n <= 0) {
    throw new RangeError('wilson(): n must be > 0');
  }
  if (successes < 0 || successes > n) {
    throw new RangeError('wilson(): successes must be within [0, n]');
  }
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    rate: p,
    lower: Math.max(0, centre - half),
    upper: Math.min(1, centre + half),
    n,
    successes,
  };
}

/**
 * Error function approximation (Abramowitz & Stegun 7.1.26).
 * Maximum absolute error 1.5e-7 — far below anything that matters here.
 */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
    t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/** Standard normal cumulative distribution function. */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export interface TwoProportionResult {
  z: number;
  /** Two-sided p-value under the pooled null hypothesis p1 = p2. */
  pValue: number;
}

/**
 * Two-proportion z-test (pooled). Used by the changepoint detector to ask
 * whether the fail rate before and after a candidate split plausibly differs.
 */
export function twoProportionTest(
  k1: number,
  n1: number,
  k2: number,
  n2: number,
): TwoProportionResult {
  if (n1 <= 0 || n2 <= 0) {
    throw new RangeError('twoProportionTest(): both sample sizes must be > 0');
  }
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const pooled = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) {
    return { z: 0, pValue: 1 };
  }
  const z = (p1 - p2) / se;
  return { z, pValue: 2 * (1 - normalCdf(Math.abs(z))) };
}

/** Format a proportion as a percentage string, e.g. 0.1834 -> "18.3%". */
export function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
