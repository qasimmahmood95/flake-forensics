import { wilson, pct, Z95 } from './stats.js';

export type State = 'HEALTHY' | 'FLAKY' | 'FAILING' | 'TOO_FEW_RUNS';

/**
 * All thresholds in one place, all configurable. Defaults and their
 * rationale are documented in the README (and repeated on each field here).
 */
export interface Thresholds {
  /**
   * Below this many runs the tool refuses to classify. Default 10: with
   * n = 9 and ZERO observed failures the 95% Wilson upper bound is still
   * ~30%, so any label would be a guess dressed up as analysis.
   */
  minRuns: number;
  /**
   * FAILING requires the Wilson LOWER bound of the hard-fail rate to be at
   * least this. Default 0.30: even at the pessimistic edge of the interval
   * the test destroys at least ~1 in 3 runs — that is a broken test, not
   * background noise.
   */
  failingMinLower: number;
  /**
   * FAILING additionally requires that retries rescue at most this fraction
   * of disruptions. Default 0.5: when retries save the majority of failures
   * the behaviour is intermittent (flaky), not deterministic.
   */
  failingMaxRescueRatio: number;
  /**
   * FLAKY requires the Wilson LOWER bound of the disruption rate to be at
   * least this. Default 0.02: we are ~97.5% confident the true per-run
   * disruption rate is >= 2% — enough to hurt a suite that runs on every
   * push, and high enough not to fire on flukes.
   */
  flakyMinLower: number;
  /**
   * FLAKY requires at least this many disrupted runs. Default 2: a single
   * event is never enough evidence to call a test flaky, whatever the rate
   * arithmetic says.
   */
  flakyMinDisruptions: number;
  /**
   * Quarantine is recommended only when the Wilson lower bound of the
   * disruption rate is at least this. Default 0.05: quarantining has a real
   * cost (lost coverage), so it is reserved for tests that confidently
   * disrupt >= 5% of runs.
   */
  quarantineMinLower: number;
  /** Days until a quarantine recommendation expires. Default 30. */
  quarantineExpiryDays: number;
  /**
   * A failure cluster is flagged environment-wide when it spans at least
   * this many distinct tests. Default 3.
   */
  envWideMinTests: number;
  /** z value for the confidence intervals. Default 1.96 (95%). */
  z: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minRuns: 10,
  failingMinLower: 0.3,
  failingMaxRescueRatio: 0.5,
  flakyMinLower: 0.02,
  flakyMinDisruptions: 2,
  quarantineMinLower: 0.05,
  quarantineExpiryDays: 30,
  envWideMinTests: 3,
  z: Z95,
};

export interface OutcomeCounts {
  /** Runs in which the test executed (skipped runs excluded). */
  n: number;
  /** Runs whose final status was failed (retries exhausted or none). */
  hardFails: number;
  /** Runs where an attempt failed but the final attempt passed. */
  rescues: number;
}

export interface ClassificationResult {
  state: State;
  /** Human-readable evidence line for the decision. */
  reason: string;
}

/**
 * The classification state machine. Rules are evaluated IN ORDER; the first
 * match wins:
 *
 *   1. TOO_FEW_RUNS  n < minRuns
 *   2. FAILING       wilsonLower(hardFails/n) >= failingMinLower
 *                    AND rescues/disruptions <= failingMaxRescueRatio
 *   3. FLAKY         disruptions >= flakyMinDisruptions
 *                    AND wilsonLower(disruptions/n) >= flakyMinLower
 *   4. HEALTHY       everything else — reported with the Wilson UPPER bound
 *                    so "healthy" reads as "disruption rate <= X% at 95%",
 *                    never as proof of health.
 */
export function classify(counts: OutcomeCounts, t: Thresholds = DEFAULT_THRESHOLDS): ClassificationResult {
  const { n, hardFails, rescues } = counts;
  const disruptions = hardFails + rescues;

  if (n < t.minRuns) {
    return {
      state: 'TOO_FEW_RUNS',
      reason: `only ${n} run${n === 1 ? '' : 's'} observed (< ${t.minRuns}); refusing to classify on this little data`,
    };
  }

  const failCI = wilson(hardFails, n, t.z);
  const disCI = wilson(disruptions, n, t.z);
  const rescueRatio = disruptions === 0 ? 0 : rescues / disruptions;

  if (failCI.lower >= t.failingMinLower && rescueRatio <= t.failingMaxRescueRatio) {
    return {
      state: 'FAILING',
      reason:
        `hard-failed ${hardFails}/${n} runs (${pct(failCI.rate)}, 95% CI ${pct(failCI.lower)}–${pct(failCI.upper)}); ` +
        `retries rescued only ${pct(rescueRatio)} of disruptions — consistent failure, not flake`,
    };
  }

  if (disruptions >= t.flakyMinDisruptions && disCI.lower >= t.flakyMinLower) {
    return {
      state: 'FLAKY',
      reason:
        `disrupted ${disruptions}/${n} runs (${pct(disCI.rate)}, 95% CI ${pct(disCI.lower)}–${pct(disCI.upper)}): ` +
        `${rescues} rescued by retry, ${hardFails} hard-failed`,
    };
  }

  const qualifier =
    disruptions === 0
      ? 'no disruptions observed'
      : `${disruptions} isolated disruption${disruptions === 1 ? '' : 's'} — below the flaky evidence bar`;
  return {
    state: 'HEALTHY',
    reason: `${qualifier} in ${n} runs; true disruption rate <= ${pct(disCI.upper)} at 95% confidence`,
  };
}
