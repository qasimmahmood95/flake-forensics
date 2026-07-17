import type { RunRecord, FinalOutcome } from './types.js';
import type { Thresholds, ClassificationResult } from './classify.js';
import { classify, DEFAULT_THRESHOLDS } from './classify.js';
import { wilson, type WilsonInterval } from './stats.js';
import { computeSignature } from './signature.js';
import { buildClusters, type Cluster, type FailureEvent } from './cluster.js';
import { detectChangepoint, type Changepoint } from './trend.js';
import { recommendQuarantine, type QuarantineRecommendation } from './quarantine.js';
import { compareTimestamps } from './util.js';

export interface RunTimelineEntry {
  runId: string;
  commit: string;
  timestamp: string;
  outcome: FinalOutcome;
}

export interface TestReport {
  testId: string;
  file: string;
  /** Runs in which the test executed (skipped excluded). */
  n: number;
  hardFails: number;
  rescues: number;
  disruptions: number;
  failRate: WilsonInterval;
  rescueRate: WilsonInterval;
  disruptionRate: WilsonInterval;
  classification: ClassificationResult;
  /**
   * Re-classification of the window AFTER a detected changepoint, so a
   * fixed test is not condemned by its history.
   */
  recent?: ClassificationResult & { sinceCommit: string; n: number; disruptions: number };
  changepoint?: Changepoint;
  clusterIds: string[];
  timeline: RunTimelineEntry[];
}

export interface RunSummary {
  runId: string;
  commit: string;
  timestamp: string;
}

export interface Analysis {
  generatedAt: string;
  runCount: number;
  firstRun?: RunSummary;
  lastRun?: RunSummary;
  thresholds: Thresholds;
  tests: TestReport[];
  clusters: Cluster[];
  quarantine: QuarantineRecommendation[];
  warnings: string[];
}

interface PerTestData {
  file: string;
  timeline: RunTimelineEntry[];
  events: FailureEvent[];
}

const OUTCOME_SEVERITY: Record<FinalOutcome, number> = {
  failed: 3,
  rescued: 2,
  passed: 1,
  skipped: 0,
};

export interface AnalyzeOptions {
  thresholds?: Partial<Thresholds>;
  warnings?: string[];
  now?: Date;
}

export function analyze(runs: RunRecord[], options: AnalyzeOptions = {}): Analysis {
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const now = options.now ?? new Date();
  const sortedRuns = [...runs].sort((a, b) => compareTimestamps(a.timestamp, b.timestamp));

  const perTest = new Map<string, PerTestData>();
  for (const run of sortedRuns) {
    // A test may appear more than once in a run (shard merges); keep the
    // worst outcome and every failure event.
    const seenThisRun = new Map<string, RunTimelineEntry>();
    for (const test of run.tests) {
      let data = perTest.get(test.testId);
      if (data === undefined) {
        data = { file: test.file, timeline: [], events: [] };
        perTest.set(test.testId, data);
      }
      const entry: RunTimelineEntry = {
        runId: run.runId,
        commit: run.commit,
        timestamp: run.timestamp,
        outcome: test.outcome,
      };
      const existing = seenThisRun.get(test.testId);
      if (existing === undefined) {
        seenThisRun.set(test.testId, entry);
        data.timeline.push(entry);
      } else if (OUTCOME_SEVERITY[test.outcome] > OUTCOME_SEVERITY[existing.outcome]) {
        existing.outcome = test.outcome;
      }

      // Only genuinely disruptive outcomes feed the clusters: a test whose
      // verdict is "passed" despite failed attempts (test.fail() and other
      // expectedStatus cases) would otherwise pollute signature clusters and
      // the environment-wide attribution denominator.
      if (test.outcome !== 'rescued' && test.outcome !== 'failed') continue;
      for (const attempt of test.attempts) {
        if ((attempt.status === 'failed' || attempt.status === 'timedOut') && attempt.error !== undefined) {
          data.events.push({
            testId: test.testId,
            runId: run.runId,
            commit: run.commit,
            timestamp: run.timestamp,
            signature: computeSignature(attempt.error),
            rawMessage: attempt.error.message,
          });
        }
      }
    }
  }

  const allEvents: FailureEvent[] = [];
  for (const data of perTest.values()) allEvents.push(...data.events);
  const clusters = buildClusters(allEvents, thresholds.envWideMinTests);
  const envWideClusterIds = new Set(clusters.filter((c) => c.envWide).map((c) => c.id));

  const tests: TestReport[] = [];
  for (const [testId, data] of perTest.entries()) {
    const executed = data.timeline.filter((t) => t.outcome !== 'skipped');
    const n = executed.length;
    const hardFails = executed.filter((t) => t.outcome === 'failed').length;
    const rescues = executed.filter((t) => t.outcome === 'rescued').length;
    const disruptions = hardFails + rescues;

    const classification = classify({ n, hardFails, rescues }, thresholds);

    const series = executed.map((t) => ({
      disrupted: t.outcome === 'failed' || t.outcome === 'rescued',
      runId: t.runId,
      commit: t.commit,
      timestamp: t.timestamp,
    }));
    const changepoint = detectChangepoint(series);

    let recent: TestReport['recent'];
    if (changepoint !== undefined) {
      const afterWindow = executed.slice(changepoint.index);
      const recentCounts = {
        n: afterWindow.length,
        hardFails: afterWindow.filter((t) => t.outcome === 'failed').length,
        rescues: afterWindow.filter((t) => t.outcome === 'rescued').length,
      };
      recent = {
        ...classify(recentCounts, thresholds),
        sinceCommit: changepoint.commit,
        n: afterWindow.length,
        disruptions: recentCounts.hardFails + recentCounts.rescues,
      };
    }

    const clusterIds = [...new Set(data.events.map((e) => e.signature.id))];

    const report: TestReport = {
      testId,
      file: data.file,
      n,
      hardFails,
      rescues,
      disruptions,
      failRate: n > 0 ? wilson(hardFails, n, thresholds.z) : emptyInterval(),
      rescueRate: n > 0 ? wilson(rescues, n, thresholds.z) : emptyInterval(),
      disruptionRate: n > 0 ? wilson(disruptions, n, thresholds.z) : emptyInterval(),
      classification,
      clusterIds,
      timeline: data.timeline,
    };
    if (recent !== undefined) report.recent = recent;
    if (changepoint !== undefined) report.changepoint = changepoint;
    tests.push(report);
  }

  // Worst first: FAILING, then FLAKY by disruption lower bound, then the rest.
  const stateOrder: Record<string, number> = { FAILING: 0, FLAKY: 1, TOO_FEW_RUNS: 2, HEALTHY: 3 };
  tests.sort((a, b) => {
    const sa = stateOrder[a.classification.state] ?? 9;
    const sb = stateOrder[b.classification.state] ?? 9;
    if (sa !== sb) return sa - sb;
    if (a.disruptionRate.lower !== b.disruptionRate.lower) {
      return b.disruptionRate.lower - a.disruptionRate.lower;
    }
    return a.testId.localeCompare(b.testId);
  });

  const quarantine = recommendQuarantine(tests, perTestEnvWideFraction(perTest, envWideClusterIds), thresholds, now);

  const first = sortedRuns[0];
  const last = sortedRuns[sortedRuns.length - 1];
  const analysis: Analysis = {
    generatedAt: now.toISOString(),
    runCount: sortedRuns.length,
    thresholds,
    tests,
    clusters,
    quarantine,
    warnings: options.warnings ?? [],
  };
  if (first !== undefined) {
    analysis.firstRun = { runId: first.runId, commit: first.commit, timestamp: first.timestamp };
  }
  if (last !== undefined) {
    analysis.lastRun = { runId: last.runId, commit: last.commit, timestamp: last.timestamp };
  }
  return analysis;
}

function emptyInterval(): WilsonInterval {
  return { rate: 0, lower: 0, upper: 1, n: 0, successes: 0 };
}

/** For each test: what fraction of its failure events sit in env-wide clusters. */
function perTestEnvWideFraction(
  perTest: Map<string, PerTestData>,
  envWideClusterIds: Set<string>,
): Map<string, number> {
  const fractions = new Map<string, number>();
  for (const [testId, data] of perTest.entries()) {
    if (data.events.length === 0) {
      fractions.set(testId, 0);
      continue;
    }
    const inEnvWide = data.events.filter((e) => envWideClusterIds.has(e.signature.id)).length;
    fractions.set(testId, inEnvWide / data.events.length);
  }
  return fractions;
}
