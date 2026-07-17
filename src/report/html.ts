import type { Analysis } from '../analyze.js';

/**
 * Single-file static HTML report: no server, no external assets. All data is
 * embedded as JSON and rendered client-side with ~100 lines of vanilla JS
 * (sortable table, per-test drill-down with a run timeline).
 */
export function renderHtml(analysis: Analysis): string {
  const data = JSON.stringify(analysis).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flake-forensics report</title>
<style>
:root {
  --bg: #ffffff; --fg: #1a1d21; --muted: #6b7280; --line: #e5e7eb; --panel: #f8fafc;
  --healthy: #16803c; --flaky: #b45309; --failing: #b91c1c; --fewruns: #6b7280;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1216; --fg: #e6e8ea; --muted: #9aa3ad; --line: #2a2f36; --panel: #171b21;
    --healthy: #4ade80; --flaky: #fbbf24; --failing: #f87171; --fewruns: #9aa3ad; }
}
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 1100px; padding: 2rem 1.25rem 4rem; background: var(--bg);
  color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
.meta { color: var(--muted); margin-bottom: 1.25rem; }
.tiles { display: flex; gap: .75rem; flex-wrap: wrap; margin: 1rem 0; }
.tile { border: 1px solid var(--line); border-radius: 8px; padding: .6rem 1rem; background: var(--panel); }
.tile b { display: block; font-size: 1.3rem; }
.tablewrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: .45rem .7rem; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { cursor: pointer; user-select: none; background: var(--panel); position: sticky; top: 0; }
th .dir { color: var(--muted); }
tbody tr.row { cursor: pointer; }
tbody tr.row:hover { background: var(--panel); }
td.testid { max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
.badge { font-weight: 600; font-size: 12px; padding: .1rem .45rem; border-radius: 999px; border: 1px solid currentColor; }
.HEALTHY { color: var(--healthy); } .FLAKY { color: var(--flaky); }
.FAILING { color: var(--failing); } .TOO_FEW_RUNS { color: var(--fewruns); }
tr.detail td { white-space: normal; background: var(--panel); padding: .9rem 1rem; }
.timeline { display: flex; flex-wrap: wrap; gap: 2px; margin: .5rem 0; }
.cell { width: 12px; height: 12px; border-radius: 2px; }
.cell.passed { background: var(--healthy); opacity: .55; }
.cell.rescued { background: var(--flaky); }
.cell.failed { background: var(--failing); }
.cell.skipped { background: var(--line); }
.evidence { color: var(--muted); }
.cluster { border: 1px solid var(--line); border-radius: 8px; padding: .75rem 1rem; margin: .5rem 0; background: var(--panel); }
.cluster code, td code { font-size: 13px; word-break: break-all; }
.envwide { font-weight: 700; color: var(--failing); }
small.mono { font-family: ui-monospace, monospace; color: var(--muted); }
</style>
</head>
<body>
<h1>flake-forensics</h1>
<div class="meta" id="meta"></div>
<div class="tiles" id="tiles"></div>
<h2>Failure clusters</h2>
<div id="clusters"></div>
<h2>Tests <small class="mono">(click a column to sort, a row for drill-down)</small></h2>
<div class="tablewrap"><table id="tbl">
<thead><tr>
<th data-k="state">State</th><th data-k="testId">Test</th><th data-k="n">Runs</th>
<th data-k="hardFails">Hard</th><th data-k="rescues">Rescued</th>
<th data-k="rate">Disrupted [95% CI]</th><th data-k="trend">Trend</th>
</tr></thead>
<tbody></tbody>
</table></div>
<script>
const DATA = ${data};
const pct = (x) => (x * 100).toFixed(1) + "%";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const short = (c) => c && c.length > 7 ? c.slice(0, 7) : c;

document.getElementById("meta").textContent =
  \`\${DATA.runCount} runs analysed\` +
  (DATA.firstRun ? \` (\${DATA.firstRun.timestamp.slice(0,10)} → \${DATA.lastRun.timestamp.slice(0,10)})\` : "") +
  \` · generated \${DATA.generatedAt.slice(0,10)} · every rate reports n and a 95% Wilson interval\`;

const counts = {};
for (const t of DATA.tests) counts[t.classification.state] = (counts[t.classification.state] || 0) + 1;
document.getElementById("tiles").innerHTML = ["FAILING","FLAKY","HEALTHY","TOO_FEW_RUNS"]
  .map((s) => \`<div class="tile"><b class="\${s}">\${counts[s] || 0}</b>\${s}</div>\`).join("");

document.getElementById("clusters").innerHTML = DATA.clusters
  .filter((c) => c.envWide || c.testIds.length > 1 || c.eventCount >= 3)
  .map((c) => \`<div class="cluster">
    \${c.envWide ? '<span class="envwide">ENVIRONMENT-WIDE</span> · ' : ""}
    <b>\${c.testIds.length}</b> test(s), <b>\${c.eventCount}</b> failures across \${c.runIds.length} runs
    (\${esc(c.firstSeen.slice(0,10))} → \${esc(c.lastSeen.slice(0,10))})<br>
    <code>\${esc(c.template)}</code><br>
    <small class="mono">at \${esc(c.frame)} · signature \${esc(c.id)}</small>
  </div>\`).join("") || "<p class='evidence'>No repeated failure signatures.</p>";

const keyFns = {
  state: (t) => ({FAILING:0,FLAKY:1,TOO_FEW_RUNS:2,HEALTHY:3}[t.classification.state]),
  testId: (t) => t.testId, n: (t) => t.n, hardFails: (t) => t.hardFails,
  rescues: (t) => t.rescues, rate: (t) => t.disruptionRate.rate,
  trend: (t) => t.changepoint ? (t.changepoint.direction === "worsened" ? 0 : 1) : 2,
};
let sortKey = "state", asc = true;

// Returns HTML-escaped text (the commit is report-controlled data).
function trendText(t) {
  if (!t.changepoint) return "—";
  const cp = t.changepoint;
  return (cp.direction === "improved" ? "↓ improved" : "↑ worsened") +
    \` @ \${esc(short(cp.commit))} (\${pct(cp.before.rate)}→\${pct(cp.after.rate)})\`;
}

function detailHtml(t) {
  const q = DATA.quarantine.find((r) => r.testId === t.testId);
  const clusters = DATA.clusters.filter((c) => t.clusterIds.includes(c.id));
  return \`
    <div><b>\${esc(t.testId)}</b></div>
    <div class="timeline">\${t.timeline.map((e) =>
      \`<span class="cell \${esc(e.outcome)}" title="\${esc(e.runId)} @ \${esc(short(e.commit))} (\${esc(e.timestamp.slice(0,10))}): \${esc(e.outcome)}"></span>\`).join("")}
    </div>
    <div class="evidence">timeline: one square per run, oldest first (green pass · amber rescued-by-retry · red hard fail)</div>
    <p>\${esc(t.classification.reason)}</p>
    <p>hard-fail rate \${pct(t.failRate.rate)} [\${pct(t.failRate.lower)}–\${pct(t.failRate.upper)}] ·
       retry-pass rate \${pct(t.rescueRate.rate)} [\${pct(t.rescueRate.lower)}–\${pct(t.rescueRate.upper)}] ·
       n = \${t.n}</p>
    \${t.recent ? \`<p><b>Since \${esc(short(t.recent.sinceCommit))}:</b> \${esc(t.recent.state)} — \${esc(t.recent.reason)}</p>\` : ""}
    \${t.changepoint ? \`<p><b>Changepoint:</b> \${trendText(t)} (p = \${t.changepoint.pValue.toExponential(1)})</p>\` : ""}
    \${q ? \`<p><b>Recommendation: \${esc(q.action.toUpperCase())}\${q.expiry ? " until " + esc(q.expiry) : ""}</b><br>
      <span class="evidence">\${esc(q.evidence)}</span></p>\` : ""}
    \${clusters.length ? "<p><b>Failure signatures:</b></p>" + clusters.map((c) =>
      \`<div class="cluster">\${c.envWide ? '<span class="envwide">ENVIRONMENT-WIDE</span> · ' : ""}
       <code>\${esc(c.template)}</code><br><small class="mono">at \${esc(c.frame)} · \${c.eventCount} events, \${c.testIds.length} test(s)</small></div>\`).join("") : ""}\`;
}

function render() {
  const rows = [...DATA.tests].sort((a, b) => {
    const ka = keyFns[sortKey](a), kb = keyFns[sortKey](b);
    const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
    return asc ? cmp : -cmp;
  });
  const tbody = document.querySelector("#tbl tbody");
  tbody.innerHTML = "";
  for (const t of rows) {
    const tr = document.createElement("tr");
    tr.className = "row";
    tr.innerHTML = \`
      <td><span class="badge \${t.classification.state}">\${t.classification.state}</span></td>
      <td class="testid" title="\${esc(t.testId)}">\${esc(t.testId)}</td>
      <td>\${t.n}</td><td>\${t.hardFails}</td><td>\${t.rescues}</td>
      <td>\${t.n ? \`\${pct(t.disruptionRate.rate)} [\${pct(t.disruptionRate.lower)}–\${pct(t.disruptionRate.upper)}]\` : "—"}</td>
      <td>\${trendText(t)}</td>\`;
    tr.addEventListener("click", () => {
      const existing = tr.nextElementSibling;
      if (existing && existing.classList.contains("detail")) { existing.remove(); return; }
      document.querySelectorAll("tr.detail").forEach((el) => el.remove());
      const detail = document.createElement("tr");
      detail.className = "detail";
      detail.innerHTML = \`<td colspan="7">\${detailHtml(t)}</td>\`;
      tr.after(detail);
    });
    tbody.appendChild(tr);
  }
  document.querySelectorAll("th").forEach((th) => {
    th.querySelector(".dir")?.remove();
    if (th.dataset.k === sortKey) th.insertAdjacentHTML("beforeend", \`<span class="dir"> \${asc ? "▲" : "▼"}</span>\`);
  });
}
document.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
  if (sortKey === th.dataset.k) asc = !asc; else { sortKey = th.dataset.k; asc = true; }
  render();
}));
render();
</script>
</body>
</html>
`;
}
