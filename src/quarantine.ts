import type { Thresholds } from './classify.js';
import { pct } from './stats.js';
import type { TestReport } from './analyze.js';

/**
 * Quarantine recommendations. Never a bare list: every entry carries the
 * evidence line that justifies it and — for actual quarantines — an expiry
 * date, because a quarantine without an expiry is just deletion in slow
 * motion.
 *
 * Actions:
 * - quarantine: flaky with a confidently high disruption rate
 * - monitor:    flaky, but quarantine is not justified (below the evidence
 *               bar, attributable to an environment-wide incident, or
 *               already healthy since a detected fix)
 * - fix:        consistently FAILING — quarantining it would silence a test
 *               that is telling the truth
 */
export interface QuarantineRecommendation {
  testId: string;
  action: 'quarantine' | 'monitor' | 'fix';
  /** ISO date (yyyy-mm-dd); present only for action = quarantine. */
  expiry?: string;
  evidence: string;
}

/** Fraction of a test's failure events that must belong to environment-wide
 *  clusters before its disruptions are attributed to the environment. */
const ENV_WIDE_ATTRIBUTION = 0.8;

export function recommendQuarantine(
  tests: TestReport[],
  envWideFraction: Map<string, number>,
  thresholds: Thresholds,
  now: Date,
): QuarantineRecommendation[] {
  const recommendations: QuarantineRecommendation[] = [];

  for (const test of tests) {
    const state = test.classification.state;
    if (state === 'HEALTHY' || state === 'TOO_FEW_RUNS') continue;

    // A detected fix trumps the historical label, FAILING included: the
    // window since the changepoint is what describes the test today. A
    // clean-but-short after-window (TOO_FEW_RUNS with zero disruptions)
    // counts too — quarantining a test that stopped failing helps nobody.
    if (test.changepoint?.direction === 'improved' && test.recent !== undefined) {
      const { recent } = test;
      if (recent.state === 'HEALTHY') {
        recommendations.push({
          testId: test.testId,
          action: 'monitor',
          evidence:
            `${test.classification.reason}. Improved since commit ${shortCommit(recent.sinceCommit)}: ` +
            `${recent.reason}. No quarantine — the fix appears to have landed.`,
        });
        continue;
      }
      if (recent.state === 'TOO_FEW_RUNS' && recent.disruptions === 0) {
        recommendations.push({
          testId: test.testId,
          action: 'monitor',
          evidence:
            `${test.classification.reason}. Clean since commit ${shortCommit(recent.sinceCommit)} but only ` +
            `${recent.n} run${recent.n === 1 ? '' : 's'} since — monitor and re-run before deciding.`,
        });
        continue;
      }
    }

    if (state === 'FAILING') {
      recommendations.push({
        testId: test.testId,
        action: 'fix',
        evidence: `${test.classification.reason}. Do not quarantine — this test is reporting a real, reproducible problem.`,
      });
      continue;
    }

    // FLAKY from here on.
    const envFraction = envWideFraction.get(test.testId) ?? 0;
    if (envFraction >= ENV_WIDE_ATTRIBUTION) {
      recommendations.push({
        testId: test.testId,
        action: 'monitor',
        evidence:
          `${test.classification.reason}. ${pct(envFraction)} of its failures belong to an environment-wide ` +
          `cluster — quarantining this test would hide an infrastructure problem, not a test problem.`,
      });
      continue;
    }

    if (test.disruptionRate.lower >= thresholds.quarantineMinLower) {
      const expiry = new Date(now.getTime() + thresholds.quarantineExpiryDays * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
      recommendations.push({
        testId: test.testId,
        action: 'quarantine',
        expiry,
        evidence:
          `${test.classification.reason}. Disruption rate is >= ${pct(thresholds.quarantineMinLower)} ` +
          `even at the 95% lower bound — quarantine until ${expiry}, then re-evaluate with fresh data.`,
      });
      continue;
    }

    recommendations.push({
      testId: test.testId,
      action: 'monitor',
      evidence:
        `${test.classification.reason}. Below the quarantine bar ` +
        `(95% lower bound ${pct(test.disruptionRate.lower)} < ${pct(thresholds.quarantineMinLower)}); keep watching.`,
    });
  }

  const actionOrder: Record<QuarantineRecommendation['action'], number> = {
    quarantine: 0,
    fix: 1,
    monitor: 2,
  };
  recommendations.sort((a, b) => actionOrder[a.action] - actionOrder[b.action] || a.testId.localeCompare(b.testId));
  return recommendations;
}

export function shortCommit(commit: string): string {
  return commit.length > 7 ? commit.slice(0, 7) : commit;
}
