import { describe, expect, it } from 'vitest';
import { classify, validateThresholds, DEFAULT_THRESHOLDS } from '../src/classify.js';

describe('classify — state machine', () => {
  it('refuses to classify below minRuns, whatever the failure pattern', () => {
    expect(classify({ n: 9, hardFails: 9, rescues: 0 }).state).toBe('TOO_FEW_RUNS');
    expect(classify({ n: 0, hardFails: 0, rescues: 0 }).state).toBe('TOO_FEW_RUNS');
    expect(classify({ n: 9, hardFails: 0, rescues: 0 }).state).toBe('TOO_FEW_RUNS');
  });

  it('classifies exactly at the minRuns boundary', () => {
    expect(classify({ n: 10, hardFails: 0, rescues: 0 }).state).toBe('HEALTHY');
  });

  it('FAILING: consistent hard failure with no rescues', () => {
    const result = classify({ n: 50, hardFails: 50, rescues: 0 });
    expect(result.state).toBe('FAILING');
    expect(result.reason).toContain('50/50');
  });

  it('FAILING: partial but confident hard failure (30/50, no rescues)', () => {
    // wilson(30, 50).lower ≈ 0.462 >= 0.30
    expect(classify({ n: 50, hardFails: 30, rescues: 0 }).state).toBe('FAILING');
  });

  it('not FAILING when the lower bound misses the bar — falls through to FLAKY', () => {
    // wilson(20, 50).lower ≈ 0.275 < 0.30
    expect(classify({ n: 50, hardFails: 20, rescues: 0 }).state).toBe('FLAKY');
  });

  it('not FAILING when retries rescue most disruptions — that is flake', () => {
    // Hard-fail lower bound would qualify, but 60% of disruptions were rescued.
    const result = classify({ n: 50, hardFails: 20, rescues: 30 });
    expect(result.state).toBe('FLAKY');
  });

  it('FLAKY: repeated retry-rescues', () => {
    const result = classify({ n: 50, hardFails: 0, rescues: 6 });
    expect(result.state).toBe('FLAKY');
    expect(result.reason).toContain('6');
  });

  it('HEALTHY: a single disruption is never enough evidence', () => {
    expect(classify({ n: 50, hardFails: 0, rescues: 1 }).state).toBe('HEALTHY');
    expect(classify({ n: 500, hardFails: 1, rescues: 0 }).state).toBe('HEALTHY');
  });

  it('HEALTHY: two disruptions in a large sample stay below the rate bar', () => {
    // wilson(2, 200).lower ≈ 0.003 < 0.02
    expect(classify({ n: 200, hardFails: 1, rescues: 1 }).state).toBe('HEALTHY');
  });

  it('FLAKY at the flaky boundary: 3/50 clears a 2% lower bound', () => {
    // wilson(3, 50).lower ≈ 0.0206 >= 0.02
    expect(classify({ n: 50, hardFails: 0, rescues: 3 }).state).toBe('FLAKY');
  });

  it('HEALTHY reason always carries the upper bound (no proof of health)', () => {
    const result = classify({ n: 50, hardFails: 0, rescues: 0 });
    expect(result.state).toBe('HEALTHY');
    expect(result.reason).toMatch(/<= \d+\.\d%/);
  });

  it('respects a custom minRuns threshold', () => {
    const t = { ...DEFAULT_THRESHOLDS, minRuns: 30 };
    expect(classify({ n: 20, hardFails: 20, rescues: 0 }, t).state).toBe('TOO_FEW_RUNS');
  });

  it('respects a custom flaky bar', () => {
    const strict = { ...DEFAULT_THRESHOLDS, flakyMinLower: 0.15 };
    expect(classify({ n: 50, hardFails: 0, rescues: 6 }, strict).state).toBe('HEALTHY');
  });

  it('never divides by zero: n = 0 is TOO_FEW_RUNS even with minRuns 0', () => {
    const t = { ...DEFAULT_THRESHOLDS, minRuns: 0 };
    const result = classify({ n: 0, hardFails: 0, rescues: 0 }, t);
    expect(result.state).toBe('TOO_FEW_RUNS');
    expect(result.reason).toContain('never executed');
  });
});

describe('validateThresholds', () => {
  it('accepts a valid partial override', () => {
    expect(validateThresholds({ minRuns: 20, flakyMinLower: 0.05 })).toEqual({
      minRuns: 20,
      flakyMinLower: 0.05,
    });
  });

  it('accepts null/undefined as empty', () => {
    expect(validateThresholds(null)).toEqual({});
    expect(validateThresholds(undefined)).toEqual({});
  });

  it('rejects string-typed values instead of silently classifying everything HEALTHY', () => {
    expect(() => validateThresholds({ minRuns: 'ten' })).toThrow(/finite non-negative number/);
    expect(() => validateThresholds({ z: null })).toThrow(/finite non-negative number/);
    expect(() => validateThresholds({ flakyMinLower: Number.NaN })).toThrow(/finite/);
  });

  it('rejects unknown keys (catches typos)', () => {
    expect(() => validateThresholds({ minRunz: 10 })).toThrow(/unknown threshold "minRunz"/);
  });

  it('rejects non-object config', () => {
    expect(() => validateThresholds([1, 2])).toThrow(/JSON object/);
    expect(() => validateThresholds('minRuns=10')).toThrow(/JSON object/);
  });
});
