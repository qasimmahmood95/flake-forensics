import { describe, expect, it } from 'vitest';
import { wilson, normalCdf, twoProportionTest, pct } from '../src/stats.js';

describe('wilson', () => {
  // Reference values computed independently (R: binom.confint(..., method="wilson")
  // and hand-checked against the closed form with z = 1.959964).
  it('matches known values for 0/10', () => {
    const ci = wilson(0, 10);
    expect(ci.rate).toBe(0);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeCloseTo(0.2775, 3);
  });

  it('matches known values for 5/10', () => {
    const ci = wilson(5, 10);
    expect(ci.rate).toBeCloseTo(0.5, 10);
    expect(ci.lower).toBeCloseTo(0.2366, 3);
    expect(ci.upper).toBeCloseTo(0.7634, 3);
  });

  it('matches known values for 1/10', () => {
    const ci = wilson(1, 10);
    expect(ci.lower).toBeCloseTo(0.0179, 3);
    expect(ci.upper).toBeCloseTo(0.4042, 3);
  });

  it('matches known values for 50/50 (degenerate top end)', () => {
    const ci = wilson(50, 50);
    expect(ci.upper).toBe(1);
    expect(ci.lower).toBeCloseTo(0.9287, 3);
  });

  it('is symmetric: wilson(k, n) mirrors wilson(n - k, n)', () => {
    const a = wilson(3, 20);
    const b = wilson(17, 20);
    expect(a.lower).toBeCloseTo(1 - b.upper, 12);
    expect(a.upper).toBeCloseTo(1 - b.lower, 12);
  });

  it('never produces a degenerate interval at small n', () => {
    const ci = wilson(0, 3);
    expect(ci.upper).toBeGreaterThan(0.5); // tiny samples stay honest
  });

  it('rejects invalid inputs', () => {
    expect(() => wilson(1, 0)).toThrow(RangeError);
    expect(() => wilson(-1, 10)).toThrow(RangeError);
    expect(() => wilson(11, 10)).toThrow(RangeError);
    expect(() => wilson(0.5, 10)).toThrow(RangeError);
  });
});

describe('normalCdf', () => {
  it('matches standard normal table values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 4);
    expect(normalCdf(2.5758)).toBeCloseTo(0.995, 4);
  });
});

describe('twoProportionTest', () => {
  it('returns p = 1 for identical proportions', () => {
    const { pValue } = twoProportionTest(5, 10, 10, 20);
    expect(pValue).toBeCloseTo(1, 6);
  });

  it('detects a large difference', () => {
    // 15/25 vs 0/25: pooled p = 0.3, se = sqrt(0.21 * 0.08) ≈ 0.1296, z ≈ 4.63.
    const { z, pValue } = twoProportionTest(15, 25, 0, 25);
    expect(z).toBeCloseTo(4.63, 1);
    expect(pValue).toBeLessThan(0.0001);
  });

  it('returns p = 1 when both proportions are zero', () => {
    const { pValue } = twoProportionTest(0, 10, 0, 10);
    expect(pValue).toBe(1);
  });
});

describe('pct', () => {
  it('formats one decimal place', () => {
    expect(pct(0.1834)).toBe('18.3%');
    expect(pct(0)).toBe('0.0%');
    expect(pct(1)).toBe('100.0%');
  });
});
