import type { Analysis, TestReport } from '../analyze.js';
import { pct } from '../stats.js';
import { shortCommit } from '../quarantine.js';

export type SortKey = 'state' | 'disruption' | 'fail' | 'rescue' | 'name';

const SORTERS: Record<SortKey, (a: TestReport, b: TestReport) => number> = {
  state: () => 0, // analysis order is already worst-state-first
  disruption: (a, b) => b.disruptionRate.rate - a.disruptionRate.rate,
  fail: (a, b) => b.failRate.rate - a.failRate.rate,
  rescue: (a, b) => b.rescueRate.rate - a.rescueRate.rate,
  name: (a, b) => a.testId.localeCompare(b.testId),
};

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function trendCell(test: TestReport): string {
  if (test.changepoint === undefined) return '—';
  const cp = test.changepoint;
  const arrow = cp.direction === 'improved' ? '↓ improved' : '↑ worsened';
  return `${arrow} @ ${shortCommit(cp.commit)} (${pct(cp.before.rate)}→${pct(cp.after.rate)})`;
}

export function renderTable(analysis: Analysis, sortKey: SortKey = 'state', limit?: number): string {
  const rows = [...analysis.tests].sort(SORTERS[sortKey]).slice(0, limit ?? analysis.tests.length);

  const header = ['STATE', 'TEST', 'RUNS', 'HARD', 'RESCUED', 'DISRUPTED [95% CI]', 'TREND'];
  const table: string[][] = [header];
  for (const t of rows) {
    table.push([
      t.classification.state,
      truncate(t.testId, 58),
      String(t.n),
      String(t.hardFails),
      String(t.rescues),
      t.n === 0
        ? '—'
        : `${pct(t.disruptionRate.rate)} [${pct(t.disruptionRate.lower)}–${pct(t.disruptionRate.upper)}]`,
      trendCell(t),
    ]);
  }

  const widths = header.map((_, col) => Math.max(...table.map((row) => (row[col] ?? '').length)));
  const lines = table.map((row) =>
    row.map((cell, col) => (cell ?? '').padEnd(widths[col] ?? 0)).join('  ').trimEnd(),
  );
  const divider = widths.map((w) => '-'.repeat(w)).join('  ');
  lines.splice(1, 0, divider);
  return lines.join('\n');
}

export function renderSummary(analysis: Analysis): string {
  const counts = new Map<string, number>();
  for (const t of analysis.tests) {
    counts.set(t.classification.state, (counts.get(t.classification.state) ?? 0) + 1);
  }
  const lines: string[] = [];
  const range =
    analysis.firstRun !== undefined && analysis.lastRun !== undefined
      ? ` (${analysis.firstRun.timestamp.slice(0, 10)} → ${analysis.lastRun.timestamp.slice(0, 10)})`
      : '';
  lines.push(`Analysed ${analysis.runCount} runs${range}, ${analysis.tests.length} distinct tests.`);
  lines.push(
    `States: ${['FAILING', 'FLAKY', 'HEALTHY', 'TOO_FEW_RUNS']
      .map((s) => `${s} ${counts.get(s) ?? 0}`)
      .join(' · ')}`,
  );

  const envWide = analysis.clusters.filter((c) => c.envWide);
  if (envWide.length > 0) {
    lines.push('');
    lines.push('Environment-wide failure clusters (one root cause, many tests):');
    for (const c of envWide) {
      lines.push(
        `  [${c.id}] ${c.testIds.length} tests, ${c.eventCount} failures across ${c.runIds.length} runs ` +
          `(${c.firstSeen.slice(0, 10)} → ${c.lastSeen.slice(0, 10)})`,
      );
      lines.push(`     ${truncate(c.template, 100)}`);
      lines.push(`     at ${c.frame}`);
    }
  }

  const quarantines = analysis.quarantine.filter((q) => q.action === 'quarantine');
  const fixes = analysis.quarantine.filter((q) => q.action === 'fix');
  if (quarantines.length > 0 || fixes.length > 0) {
    lines.push('');
    lines.push(
      `Recommendations: ${quarantines.length} quarantine, ${fixes.length} fix, ` +
        `${analysis.quarantine.length - quarantines.length - fixes.length} monitor ` +
        '(details in quarantine output)',
    );
  }

  if (analysis.warnings.length > 0) {
    lines.push('');
    lines.push(`Warnings (${analysis.warnings.length}):`);
    for (const w of analysis.warnings.slice(0, 10)) lines.push(`  ! ${w}`);
    if (analysis.warnings.length > 10) lines.push(`  … and ${analysis.warnings.length - 10} more`);
  }
  return lines.join('\n');
}
