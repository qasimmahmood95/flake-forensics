/**
 * Seeded, deterministic generator for the demo fixture set: 50 synthetic
 * Playwright JSON reports engineered to contain
 *   - one genuine flake            (cart.spec.ts › applies discount code)
 *   - one consistent failure       (auth.spec.ts › rejects expired session token)
 *   - one environment-wide cluster (8 tests, ECONNREFUSED, runs 31–35)
 *   - one improving test           (search.spec.ts › filters results by tag,
 *                                   fixed at run 26's commit)
 *   - healthy background noise     (15 tests with rare rescued blips)
 *
 * Regenerate with `pnpm fixtures`; verify the committed fixtures match the
 * seed with `pnpm fixtures:check` (CI does this so the demo stays honest).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED = 0x5eed0004;
const RUN_COUNT = 50;
const RETRIES = 2; // up to 3 attempts per test
const BASE_TIME_MS = Date.UTC(2026, 4, 1, 3, 0, 0); // 2026-05-01T03:00:00Z
const RUN_INTERVAL_MS = 6 * 3600 * 1000;

/** Runs (0-based) during which the shared API backend is down. */
const OUTAGE_RUNS = new Set([30, 31, 32, 33, 34]);
/** First run (0-based) after the fix for the improving test. */
const SEARCH_FIX_RUN = 25;

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const OUT_DIR = path.join(FIXTURES_DIR, 'runs');

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const randHex = (chars: number): string =>
  Array.from({ length: chars }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
const randInt = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));

// ---------------------------------------------------------------------------
// Error fabrication
// ---------------------------------------------------------------------------
interface FakeError {
  message: string;
  stack: string;
}

const stackFor = (message: string, fn: string, file: string, line: number): string =>
  `${message.split('\n')[0]}\n` +
  `    at ${fn} (/home/runner/work/webshop/webshop/tests/e2e/${file}:${line}:${randInt(3, 40)})\n` +
  `    at /home/runner/work/webshop/webshop/node_modules/@playwright/test/lib/worker/workerMain.js:${randInt(100, 400)}:11`;

const discountTimeoutError = (): FakeError => {
  const message =
    `TimeoutError: locator.click: Timeout 15000ms exceeded.\n` +
    `Call log:\n` +
    `  - waiting for locator('[data-test="apply-discount"]')\n` +
    `  -   locator resolved to <button disabled [data-test="apply-discount"]>…</button>`;
  return { message, stack: stackFor(message, 'applyDiscount', 'cart.spec.ts', 42) };
};

const authAssertionError = (): FakeError => {
  const message =
    `Error: expect(received).toBe(expected) // Object.is equality\n\n` +
    `Expected: 401\nReceived: 200`;
  return { message, stack: stackFor(message, 'expectRejected', 'auth.spec.ts', 88) };
};

const econnrefusedError = (): FakeError => {
  const port = randInt(30000, 49999);
  const message = `Error: apiRequest failed: connect ECONNREFUSED 127.0.0.1:${port}`;
  return { message, stack: stackFor(message, 'apiRequest', 'helpers/api.ts', 17) };
};

const searchAssertionError = (): FakeError => {
  const message =
    `Error: expect(received).toEqual(expected) // deep equality\n\n` +
    `Expected: ["backend", "frontend"]\nReceived: []`;
  return { message, stack: stackFor(message, 'assertTagFilter', 'search.spec.ts', 61) };
};

const noiseErrorFor = (file: string, title: string): FakeError => {
  const message = `TimeoutError: page.waitForSelector: Timeout ${randInt(5, 30) * 1000}ms exceeded.\nCall log:\n  - waiting for selector "[data-test='${title.replace(/\s+/g, '-')}']"`;
  return { message, stack: stackFor(message, 'waitForReady', file, randInt(10, 90)) };
};

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------
type AttemptPlan = { status: 'passed' | 'failed'; error?: FakeError };

interface TestDef {
  file: string;
  describe: string;
  title: string;
  /** Returns the attempt sequence for the given run index. */
  plan: (runIndex: number) => AttemptPlan[];
}

/** Attempts fail independently with probability p; retries up to RETRIES. */
function independentAttempts(p: number, makeError: () => FakeError): AttemptPlan[] {
  const attempts: AttemptPlan[] = [];
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (rand() < p) {
      attempts.push({ status: 'failed', error: makeError() });
    } else {
      attempts.push({ status: 'passed' });
      return attempts;
    }
  }
  return attempts;
}

/** Every attempt fails — a deterministic failure. */
function deterministicFailure(makeError: () => FakeError): AttemptPlan[] {
  return Array.from({ length: RETRIES + 1 }, () => ({
    status: 'failed' as const,
    error: makeError(),
  }));
}

const HEALTHY_NOISE_P = 0.008;

const API_DEPENDENT_TESTS: Array<[string, string, string]> = [
  ['orders.spec.ts', 'orders', 'lists recent orders'],
  ['orders.spec.ts', 'orders', 'shows order detail'],
  ['profile.spec.ts', 'profile', 'updates display name'],
  ['profile.spec.ts', 'profile', 'uploads avatar'],
  ['inventory.spec.ts', 'inventory', 'shows stock level'],
  ['inventory.spec.ts', 'inventory', 'filters by warehouse'],
  ['wishlist.spec.ts', 'wishlist', 'adds item to wishlist'],
  ['wishlist.spec.ts', 'wishlist', 'removes item from wishlist'],
];

const HEALTHY_TESTS: Array<[string, string, string]> = [
  ['home.spec.ts', 'home', 'renders hero banner'],
  ['home.spec.ts', 'home', 'shows featured products'],
  ['home.spec.ts', 'home', 'navigates to category page'],
  ['cart.spec.ts', 'checkout', 'shows empty-cart message'],
  ['cart.spec.ts', 'checkout', 'updates line-item quantity'],
  ['cart.spec.ts', 'checkout', 'calculates shipping estimate'],
  ['auth.spec.ts', 'login', 'logs in with valid credentials'],
  ['auth.spec.ts', 'login', 'shows validation for empty form'],
  ['search.spec.ts', 'search', 'returns results for exact match'],
  ['search.spec.ts', 'search', 'paginates long result lists'],
  ['product.spec.ts', 'product page', 'renders image gallery'],
  ['product.spec.ts', 'product page', 'shows related products'],
  ['product.spec.ts', 'product page', 'validates review form'],
  ['footer.spec.ts', 'footer', 'renders newsletter signup'],
  ['footer.spec.ts', 'footer', 'links to policy pages'],
];

function buildTestDefs(): TestDef[] {
  const defs: TestDef[] = [];

  // 1. The genuine flake: independent per-attempt failure, usually rescued.
  defs.push({
    file: 'cart.spec.ts',
    describe: 'checkout',
    title: 'applies discount code before payment',
    plan: () => independentAttempts(0.18, discountTimeoutError),
  });

  // 2. The consistent failure: broken assertion, retries never help.
  defs.push({
    file: 'auth.spec.ts',
    describe: 'login',
    title: 'rejects expired session token',
    plan: () => deterministicFailure(authAssertionError),
  });

  // 3. Environment-wide cluster: healthy tests that all die when the shared
  //    API is down. Ports differ per failure — normalisation must unify them.
  for (const [file, describe, title] of API_DEPENDENT_TESTS) {
    defs.push({
      file,
      describe,
      title,
      plan: (runIndex) =>
        OUTAGE_RUNS.has(runIndex)
          ? deterministicFailure(econnrefusedError)
          : independentAttempts(HEALTHY_NOISE_P, () => noiseErrorFor(file, title)),
    });
  }

  // 4. The improving test: badly broken, then fixed at SEARCH_FIX_RUN.
  defs.push({
    file: 'search.spec.ts',
    describe: 'search',
    title: 'filters results by tag',
    plan: (runIndex) =>
      runIndex < SEARCH_FIX_RUN
        ? rand() < 0.6
          ? deterministicFailure(searchAssertionError)
          : [{ status: 'passed' }]
        : independentAttempts(0.005, searchAssertionError),
  });

  // 5. Healthy background noise.
  for (const [file, describe, title] of HEALTHY_TESTS) {
    defs.push({
      file,
      describe,
      title,
      plan: () => independentAttempts(HEALTHY_NOISE_P, () => noiseErrorFor(file, title)),
    });
  }

  return defs;
}

// ---------------------------------------------------------------------------
// Playwright JSON assembly
// ---------------------------------------------------------------------------
function buildReport(runIndex: number, commit: string, defs: TestDef[]): object {
  const timestamp = new Date(BASE_TIME_MS + runIndex * RUN_INTERVAL_MS).toISOString();
  const runId = `gha-${9000 + runIndex}`;

  interface SpecJson {
    title: string;
    ok: boolean;
    tags: string[];
    tests: object[];
    file: string;
    line: number;
    column: number;
  }
  const fileSuites = new Map<string, Map<string, SpecJson[]>>();

  for (const def of defs) {
    const attempts = def.plan(runIndex);
    const finalStatus = attempts[attempts.length - 1]?.status ?? 'passed';
    const anyFailed = attempts.some((a) => a.status === 'failed');
    const status =
      finalStatus === 'passed' ? (anyFailed ? 'flaky' : 'expected') : 'unexpected';

    const results = attempts.map((attempt, retry) => ({
      workerIndex: randInt(0, 3),
      status: attempt.status,
      duration: randInt(400, 6000),
      ...(attempt.error !== undefined
        ? { error: attempt.error, errors: [attempt.error] }
        : { errors: [] }),
      stdout: [],
      stderr: [],
      retry,
      startTime: new Date(BASE_TIME_MS + runIndex * RUN_INTERVAL_MS + retry * 20_000).toISOString(),
      attachments: [],
    }));

    const spec: SpecJson = {
      title: def.title,
      ok: status !== 'unexpected',
      tags: [],
      tests: [
        {
          timeout: 30000,
          annotations: [],
          expectedStatus: 'passed',
          projectId: 'chromium',
          projectName: 'chromium',
          results,
          status,
        },
      ],
      file: def.file,
      line: randInt(5, 120),
      column: 3,
    };

    let byDescribe = fileSuites.get(def.file);
    if (byDescribe === undefined) {
      byDescribe = new Map();
      fileSuites.set(def.file, byDescribe);
    }
    const specs = byDescribe.get(def.describe) ?? [];
    specs.push(spec);
    byDescribe.set(def.describe, specs);
  }

  const suites = [...fileSuites.entries()].map(([file, byDescribe]) => ({
    title: file,
    file,
    line: 0,
    column: 0,
    specs: [],
    suites: [...byDescribe.entries()].map(([describe, specs]) => ({
      title: describe,
      file,
      line: 3,
      column: 1,
      specs,
    })),
  }));

  return {
    config: {
      configFile: '/home/runner/work/webshop/webshop/playwright.config.ts',
      rootDir: '/home/runner/work/webshop/webshop/tests/e2e',
      metadata: { commit, ciRunId: runId, timestamp },
      workers: 4,
    },
    suites,
    errors: [],
    stats: {
      startTime: timestamp,
      duration: randInt(120_000, 400_000),
      expected: 0,
      unexpected: 0,
      flaky: 0,
      skipped: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const defs = buildTestDefs();

  const commits: string[] = Array.from({ length: RUN_COUNT }, () => randHex(40));

  const files = new Map<string, string>();
  for (let i = 0; i < RUN_COUNT; i++) {
    const commit = commits[i];
    if (commit === undefined) throw new Error('unreachable');
    const report = buildReport(i, commit, defs);
    const name = `run-${String(i + 1).padStart(3, '0')}.json`;
    files.set(name, `${JSON.stringify(report, null, 2)}\n`);
  }

  const manifest = {
    seed: SEED,
    runCount: RUN_COUNT,
    scenarios: {
      genuineFlake: '[chromium] cart.spec.ts › checkout › applies discount code before payment',
      consistentFailure: '[chromium] auth.spec.ts › login › rejects expired session token',
      environmentOutage: {
        runs: [...OUTAGE_RUNS].map((i) => `run-${String(i + 1).padStart(3, '0')}`),
        testsAffected: API_DEPENDENT_TESTS.length,
      },
      improvingTest: {
        testId: '[chromium] search.spec.ts › search › filters results by tag',
        fixedAtRun: `run-${String(SEARCH_FIX_RUN + 1).padStart(3, '0')}`,
        fixCommit: commits[SEARCH_FIX_RUN],
      },
    },
  };
  // The manifest lives OUTSIDE fixtures/runs so directory scans of the run
  // reports do not trip over it.
  files.set(path.join('..', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  if (check) {
    let mismatches = 0;
    for (const [name, expected] of files.entries()) {
      const actual = await fs.readFile(path.join(OUT_DIR, name), 'utf8').catch(() => undefined);
      if (actual !== expected) {
        console.error(`MISMATCH: fixtures/${path.basename(name)} does not match the seeded generator output`);
        mismatches += 1;
      }
    }
    const onDisk = (await fs.readdir(OUT_DIR)).filter((f) => f.endsWith('.json'));
    for (const name of onDisk) {
      if (!files.has(name)) {
        console.error(`UNEXPECTED: fixtures/runs/${name} is not produced by the generator`);
        mismatches += 1;
      }
    }
    if (mismatches > 0) {
      console.error(`${mismatches} fixture file(s) out of sync. Run: pnpm fixtures`);
      process.exit(1);
    }
    console.log(`OK: ${files.size} fixture files match the seeded generator (seed ${SEED}).`);
    return;
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  for (const [name, content] of files.entries()) {
    await fs.writeFile(path.join(OUT_DIR, name), content, 'utf8');
  }
  console.log(`Wrote ${files.size} files under fixtures/ (seed ${SEED}).`);
  console.log(`Improving test fixed at commit ${manifest.scenarios.improvingTest.fixCommit?.slice(0, 7)} (${manifest.scenarios.improvingTest.fixedAtRun}).`);
}

await main();
