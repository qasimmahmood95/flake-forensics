import type { Analysis } from '../analyze.js';

/**
 * Renders a `quarantine.md` a team could commit directly: a proposal with
 * evidence, not a bare list of test names.
 */
export function renderQuarantineMd(analysis: Analysis): string {
  const lines: string[] = [];
  lines.push('# Quarantine proposal');
  lines.push('');
  lines.push(
    `Generated ${analysis.generatedAt.slice(0, 10)} by flake-forensics ` +
      `from ${analysis.runCount} CI runs` +
      (analysis.firstRun !== undefined && analysis.lastRun !== undefined
        ? ` (${analysis.firstRun.timestamp.slice(0, 10)} → ${analysis.lastRun.timestamp.slice(0, 10)})`
        : '') +
      '.',
  );
  lines.push('');
  lines.push(
    'Every recommendation carries the evidence that justifies it. Quarantines expire: ' +
      're-run the analysis before the expiry date and either fix the test or renew with fresh evidence.',
  );

  const byAction = {
    quarantine: analysis.quarantine.filter((q) => q.action === 'quarantine'),
    fix: analysis.quarantine.filter((q) => q.action === 'fix'),
    monitor: analysis.quarantine.filter((q) => q.action === 'monitor'),
  };

  lines.push('');
  lines.push('## Quarantine (with expiry)');
  lines.push('');
  if (byAction.quarantine.length === 0) {
    lines.push('_No tests currently meet the quarantine evidence bar._');
  } else {
    for (const q of byAction.quarantine) {
      lines.push(`- [ ] \`${q.testId}\` — **expires ${q.expiry}**`);
      lines.push(`  - ${q.evidence}`);
    }
  }

  lines.push('');
  lines.push('## Fix, do not quarantine');
  lines.push('');
  if (byAction.fix.length === 0) {
    lines.push('_No consistently failing tests._');
  } else {
    for (const q of byAction.fix) {
      lines.push(`- [ ] \`${q.testId}\``);
      lines.push(`  - ${q.evidence}`);
    }
  }

  lines.push('');
  lines.push('## Monitor');
  lines.push('');
  if (byAction.monitor.length === 0) {
    lines.push('_Nothing on the watchlist._');
  } else {
    for (const q of byAction.monitor) {
      lines.push(`- \`${q.testId}\``);
      lines.push(`  - ${q.evidence}`);
    }
  }

  const envWide = analysis.clusters.filter((c) => c.envWide);
  if (envWide.length > 0) {
    lines.push('');
    lines.push('## Environment-wide incidents detected');
    lines.push('');
    for (const c of envWide) {
      lines.push(
        `- **${c.testIds.length} tests / ${c.eventCount} failures** share one error signature ` +
          `(\`${c.id}\`, ${c.firstSeen.slice(0, 10)} → ${c.lastSeen.slice(0, 10)}):`,
      );
      lines.push(`  - \`${c.template}\``);
      lines.push(`  - at \`${c.frame}\``);
      lines.push('  - Treat as one infrastructure issue, not as per-test flakiness.');
    }
  }

  lines.push('');
  return lines.join('\n');
}
