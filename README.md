# flake-forensics

[![ci](https://github.com/qasimmahmood95/flake-forensics/actions/workflows/ci.yml/badge.svg)](https://github.com/qasimmahmood95/flake-forensics/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Statistically honest flake analysis for [Playwright](https://playwright.dev) JSON reports across many CI runs.

Point it at a directory of Playwright JSON reports (one per CI run) and it tells you — with sample
sizes and confidence intervals attached to every number — which tests are flaky, which are plain
broken, which failures share a single root cause, which tests changed behaviour and when, and which
(if any) deserve quarantine.

```
STATE    TEST                                                        RUNS  HARD  RESCUED  DISRUPTED [95% CI]     TREND
-------  ----------------------------------------------------------  ----  ----  -------  ---------------------  ---------------------------------
FAILING  [chromium] auth.spec.ts › login › rejects expired session…  50    50    0        100.0% [92.9%–100.0%]  —
FLAKY    [chromium] search.spec.ts › search › filters results by t…  50    17    0        34.0% [22.4%–47.8%]    ↓ improved @ 2d1d9ba (68.0%→0.0%)
FLAKY    [chromium] cart.spec.ts › checkout › applies discount cod…  50    1     8        18.0% [9.8%–30.8%]     —
FLAKY    [chromium] orders.spec.ts › orders › lists recent orders    50    5     0        10.0% [4.3%–21.4%]     ↑ worsened @ 7c6c9bc (0.0%→25.0%)
HEALTHY  [chromium] home.spec.ts › home › renders hero banner        50    0     1        2.0% [0.4%–10.5%]      —
```
*(real output of `pnpm demo` against the committed fixture set, abridged)*

## Why counting retries isn't analysis

Most "flake dashboards" count how often a test needed a retry and sort descending. That number is
easy to produce and easy to misread:

- **A count without a denominator is meaningless.** 5 retries is catastrophic over 10 runs and
  noise over 5,000. Every rate this tool reports carries its `n`.
- **A rate without an interval invites overreaction.** A test that flaked once in 12 runs shows
  8.3% — but the 95% interval on 1/12 spans roughly 0.4%–35%. You know almost nothing yet.
  Teams quarantine tests on evidence this thin every day.
- **Retry counts conflate two opposite problems.** A test that fails and then passes on retry
  (flake) and a test that fails all its retries (real failure) both "failed". One is noise to
  contain; the other is a bug telling the truth. Averaging them produces a number that describes
  neither.
- **Forty red tests can be one problem.** When the test API is down for an afternoon, every test
  that touches it fails. Per-test counting reads that as forty flaky tests; grouping failures by
  normalised error signature reads it as one incident — which is what it was.

flake-forensics is built around those four corrections, and refuses to classify when the data
cannot support a conclusion.

## The statistics, for a QA audience

**Retry-pass rate vs hard-fail rate.** For each test in each run there are three interesting
outcomes: passed cleanly, *rescued* (an attempt failed, a retry passed — the direct flake
signature), or *hard-failed* (retries exhausted). "Disrupted" means rescued or hard-failed. These
are counted separately because they mean different things: a high rescue rate is flake; a high
hard-fail rate with no rescues is a broken test.

**Wilson confidence intervals.** An observed rate like "2 disruptions in 15 runs" is an estimate
of the true rate, and with small `n` it is a bad one. The
[Wilson score interval](https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval#Wilson_score_interval)
gives the range the true rate plausibly lies in (95% by default), and unlike the naive formula it
behaves sensibly at 0% and 100% and at small sample sizes. Decision rules in this tool use the
**lower bound** — the tool only accuses a test when even the charitable reading looks bad.

**Changepoints.** Per test, the tool scans the run history for the single split point that best
divides it into "before" and "after" with different disruption rates (a pooled two-proportion
z-test, p < 0.01, and at least a 20-point rate change). This flags *this test's behaviour changed
around commit X* — a lead, not a verdict.

## The classification state machine

Per test: `n` runs executed, `F` hard-fail runs, `R` rescued runs, `D = F + R` disrupted runs.
`lo()`/`hi()` are 95% Wilson bounds. Rules are evaluated **in order; first match wins**:

| # | State | Rule (defaults) | Rationale |
|---|-------|-----------------|-----------|
| 1 | `TOO_FEW_RUNS` | `n < 10` | With n = 9 and zero failures, the upper bound on the true rate is still ~30%. Below `minRuns` any label is a guess, so the tool refuses to guess. |
| 2 | `FAILING` | `lo(F/n) ≥ 0.30` **and** `R/D ≤ 0.50` | Even at the pessimistic edge of the interval, the test destroys ≥ 30% of runs, and retries rescue at most half its disruptions. That is a broken test — not flake. |
| 3 | `FLAKY` | `D ≥ 2` **and** `lo(D/n) ≥ 0.02` | At least two independent disruptions (one event is never evidence), and ~97.5% confidence the true disruption rate is ≥ 2% — enough to hurt a suite that runs on every push. |
| 4 | `HEALTHY` | everything else | Reported with the **upper** bound: "healthy" means "disruption rate ≤ X% at 95% confidence", never proof of health. |

Two overlays refine the label:

- **Recency**: if a changepoint is detected, the window after it is re-classified separately, so a
  fixed test reads "FLAKY overall, HEALTHY since commit X" rather than being condemned by history.
- **Attribution**: if ≥ 80% of a test's failures belong to an environment-wide cluster, its
  flakiness is attributed to the incident, not the test.

All thresholds are configurable (`--config thresholds.json`, or `--min-runs` directly):

```json
{
  "minRuns": 10,
  "failingMinLower": 0.30,
  "failingMaxRescueRatio": 0.50,
  "flakyMinLower": 0.02,
  "flakyMinDisruptions": 2,
  "quarantineMinLower": 0.05,
  "quarantineExpiryDays": 30,
  "envWideMinTests": 3
}
```

## Error-signature normalisation

One root cause spanning 40 tests should read as one cluster. Every failed attempt's error is
reduced to a signature: `hash(message template + top application stack frame)`.

The message template pipeline, in order:

1. strip ANSI colour codes
2. drop everything from `Call log:` onward (per-attempt noise)
3. keep at most the first 5 non-empty lines
4. replace `Expected:` / `Received:` values with `<VAL>` — assertion *values* are volatile, the
   assertion *shape* is the signal
5. token rules, in order (order matters — URLs before addresses, addresses before bare numbers):
   ISO timestamps → `<TIMESTAMP>`, UUIDs → `<UUID>`, long hex ids → `<HEX>`, URLs → `<URL>`,
   `ip:port` / `localhost:port` → `<ADDR>`, multi-segment paths → `<PATH>`,
   durations (`15000ms`, `30s`) → `<DURATION>`, remaining numbers → `<N>`
6. collapse whitespace, cap at 240 chars

Quoted strings and selectors are deliberately **kept** — they are structural — but token rules run
inside them, so `locator('#row-42')` and `locator('#row-97')` unify to `locator('#row-<N>')`.

The stack frame is the first one that is not `node_modules`, Node internals, or Playwright itself.
Line/column numbers are **dropped** (they shift with every commit); the file path (made
repo-relative) and function name are kept. So:

```
connect ECONNREFUSED 127.0.0.1:34567   at apiRequest (tests/helpers/api.ts:17:3)
connect ECONNREFUSED 127.0.0.1:49152   at apiRequest (tests/helpers/api.ts:21:9)
    → both: "Error: apiRequest failed: connect ECONNREFUSED <ADDR>" @ tests/helpers/api.ts#apiRequest
```

A cluster whose signature spans ≥ 3 distinct tests is flagged **environment-wide**.

## Quickstart

```bash
pnpm install
pnpm demo        # analyses the committed 50-run fixture set
```

Against your own reports (`npx playwright test --reporter=json > report.json` per CI run, archived
per run in one directory):

```bash
flake-forensics analyze ./reports \
  --json analysis.json \
  --html report.html \
  --quarantine quarantine.md
```

- **CLI table** — `--sort state|disruption|fail|rescue|name`, `--limit N`
- **`analysis.json`** — the full machine-readable analysis (every rate with `n`, CI, evidence)
- **`report.html`** — single static file, no server: sortable table, per-test drill-down with a
  per-run timeline, clusters, recommendations
- **`quarantine.md`** — a proposal a team could commit directly: every entry carries its evidence
  line, every quarantine carries an expiry date

### Run metadata

Each report needs a commit, timestamp and run id. The tool looks, in order, at: a
`<report>.meta.json` sidecar (`{ "commit": "...", "timestamp": "...", "runId": "..." }`), the
report's `config.metadata` (`commit`/`gitCommit`, `timestamp`, `ciRunId`), the report's
`stats.startTime`, and finally the file mtime (with a warning). The easiest way to embed metadata
at test time:

```ts
// playwright.config.ts
export default defineConfig({
  metadata: {
    commit: process.env.GITHUB_SHA,
    ciRunId: process.env.GITHUB_RUN_ID,
    timestamp: new Date().toISOString(),
  },
});
```

### Fetching reports from GitHub Actions (optional)

If your workflow uploads the JSON report as an artifact, the bundled helper pulls a run history:

```bash
GITHUB_TOKEN=... flake-forensics fetch \
  --repo your-org/your-app --workflow ci.yml \
  --artifact playwright-report --runs 50 --out ./reports
```

It writes each run's report plus a `.meta.json` sidecar carrying the run's commit and start time
from the GitHub API. The local directory remains the primary path; `fetch` is a convenience.

## The demo, and what it proves

`fixtures/runs/` contains 50 synthetic Playwright reports produced by a **committed, seeded
generator** ([scripts/generate-fixtures.ts](scripts/generate-fixtures.ts)) — CI regenerates them
and fails if they drift, so the demo cannot quietly be hand-tuned. The set contains five engineered
situations; `pnpm demo` should separate all five:

| Engineered situation | Expected finding |
|---|---|
| `cart.spec.ts › applies discount code` fails ~18% of attempts, retries usually rescue it | **FLAKY**, quarantine recommended with expiry and CI-backed evidence |
| `auth.spec.ts › rejects expired session token` fails every attempt of every run | **FAILING**, recommendation is *fix* — quarantining it would silence a truth-teller |
| 8 API-dependent tests all hard-fail during runs 31–35 (`ECONNREFUSED`, differing ports) | one **environment-wide cluster**; each test's flakiness is attributed to the incident — *monitor*, not 8 quarantines |
| `search.spec.ts › filters results by tag` fails ~60% before run 26, ~0% after | **changepoint flagged as improved** at the fix commit; recent window HEALTHY; no quarantine |
| 15 healthy tests with rare (<1%) rescued blips | **HEALTHY**, with explicit upper bounds |

One instructive artefact to notice: the outage-affected tests carry a "worsened" changepoint flag
pointing at the run where the outage began. That is the single-split model being honest about a
pulse it cannot represent — the drill-down and the quarantine proposal both attribute those
failures to the environment-wide cluster, which is the correct lens.

## Limitations (read before trusting it)

- **Observational data only.** The tool sees pass/fail records, not causes. A changepoint at
  commit X means the *behaviour* changed near X — the culprit may be the commit, the runner image,
  or the phase of the moon. It narrows where to look; it does not root-cause.
- **Classification is threshold-based.** The defaults are documented and configurable, but they
  are policy, not truth. A test can be genuinely flaky at 1% and this tool will call it HEALTHY
  until the evidence accumulates.
- **Changepoint detection is deliberately simple.** One split point, strict significance, minimum
  effect size. It will miss gradual drift and multiple regime changes, and scanning many tests
  means occasional false flags survive even at p < 0.01.
- **Signature normalisation is heuristic.** Distinct bugs can collide on one template; one bug can
  straddle two templates if its message varies structurally. Clusters are leads for a human, and
  each cluster keeps a raw sample message so you can check the template against reality.
- **Retries must be enabled** for the rescued/hard-fail distinction to carry signal. With
  `retries: 0`, flake and failure are only separable by rate and clustering.

## Development

```bash
pnpm install
pnpm test            # unit tests (statistics against known values, normalisation, thresholds)
pnpm lint && pnpm typecheck
pnpm fixtures        # regenerate the fixture set (seeded, deterministic)
pnpm fixtures:check  # verify committed fixtures match the generator (CI runs this)
pnpm demo            # run the full analysis on the fixtures -> demo/
```

MIT — see [LICENSE](LICENSE).
