import type { Signature } from './signature.js';

/** One failed attempt with an error, anywhere in the ingested data. */
export interface FailureEvent {
  testId: string;
  runId: string;
  commit: string;
  timestamp: string;
  signature: Signature;
  rawMessage: string;
  /** True when this attempt was the final one (the run hard-failed). */
  final: boolean;
}

export interface Cluster {
  id: string;
  template: string;
  frame: string;
  eventCount: number;
  testIds: string[];
  runIds: string[];
  firstSeen: string;
  lastSeen: string;
  /**
   * Flagged when the same signature spans many distinct tests — one root
   * cause (an outage, a broken helper, a bad deploy) masquerading as many
   * test problems.
   */
  envWide: boolean;
  /** One raw message kept verbatim so humans can sanity-check the template. */
  sampleRaw: string;
}

export function buildClusters(events: FailureEvent[], envWideMinTests: number): Cluster[] {
  const bySignature = new Map<string, FailureEvent[]>();
  for (const event of events) {
    const list = bySignature.get(event.signature.id);
    if (list === undefined) {
      bySignature.set(event.signature.id, [event]);
    } else {
      list.push(event);
    }
  }

  const clusters: Cluster[] = [];
  for (const group of bySignature.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const testIds = [...new Set(group.map((e) => e.testId))].sort();
    const runIds = [...new Set(group.map((e) => e.runId))];
    const timestamps = group.map((e) => e.timestamp).sort();
    clusters.push({
      id: first.signature.id,
      template: first.signature.template,
      frame: first.signature.frame,
      eventCount: group.length,
      testIds,
      runIds,
      firstSeen: timestamps[0] ?? '',
      lastSeen: timestamps[timestamps.length - 1] ?? '',
      envWide: testIds.length >= envWideMinTests,
      sampleRaw: first.rawMessage,
    });
  }

  // Environment-wide clusters first, then by breadth of impact.
  clusters.sort((a, b) => {
    if (a.envWide !== b.envWide) return a.envWide ? -1 : 1;
    if (a.testIds.length !== b.testIds.length) return b.testIds.length - a.testIds.length;
    return b.eventCount - a.eventCount;
  });
  return clusters;
}
