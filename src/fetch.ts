import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';

/**
 * Optional helper: pull Playwright JSON report artifacts from GitHub Actions.
 * The local directory is the primary ingestion path; this exists so a team
 * can bootstrap a run history without wiring anything else up.
 *
 * Requires a token with `actions:read` (classic `repo` scope works) in
 * GITHUB_TOKEN or --token. For each workflow run it downloads the named
 * artifact, extracts every `*.json` inside, and writes a `*.meta.json`
 * sidecar carrying { runId, commit, timestamp } so ingestion can attribute
 * the reports without trusting report-internal metadata.
 */

export interface FetchOptions {
  /** owner/name */
  repo: string;
  /** Workflow file name (ci.yml) or numeric workflow id. */
  workflow: string;
  /** Artifact name to download from each run. */
  artifact: string;
  outDir: string;
  /** Number of most recent completed runs to pull. */
  limit: number;
  token: string;
  log?: (message: string) => void;
}

interface GhWorkflowRun {
  id: number;
  head_sha: string;
  run_started_at?: string;
  created_at: string;
  status: string;
}

interface GhArtifact {
  id: number;
  name: string;
  expired: boolean;
  archive_download_url: string;
}

const API = 'https://api.github.com';

async function ghJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${url}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function fetchArtifacts(options: FetchOptions): Promise<{ reportsWritten: number }> {
  const { repo, workflow, artifact, outDir, limit, token } = options;
  const log = options.log ?? (() => undefined);
  await fs.mkdir(outDir, { recursive: true });

  // GitHub caps per_page at 100, so page until `limit` runs are collected.
  const runs: GhWorkflowRun[] = [];
  for (let page = 1; runs.length < limit; page++) {
    const perPage = Math.min(100, limit - runs.length);
    const runsUrl =
      `${API}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs` +
      `?status=completed&per_page=${perPage}&page=${page}`;
    const { workflow_runs: batch } = await ghJson<{ workflow_runs: GhWorkflowRun[] }>(runsUrl, token);
    runs.push(...batch);
    if (batch.length < perPage) break;
  }
  log(`Found ${runs.length} completed runs for ${repo} / ${workflow}`);

  let reportsWritten = 0;
  for (const run of runs) {
    const { artifacts } = await ghJson<{ artifacts: GhArtifact[] }>(
      `${API}/repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`,
      token,
    );
    const match = artifacts.find((a) => a.name === artifact && !a.expired);
    if (match === undefined) {
      log(`run ${run.id}: no unexpired artifact named "${artifact}"; skipping`);
      continue;
    }

    const res = await fetch(match.archive_download_url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      log(`run ${run.id}: artifact download failed (${res.status}); skipping`);
      continue;
    }
    const zip = new Uint8Array(await res.arrayBuffer());
    const entries = unzipSync(zip);

    for (const [name, bytes] of Object.entries(entries)) {
      if (!name.endsWith('.json') || name.endsWith('.meta.json')) continue;
      // Keep the entry's full (sanitised) path in the filename: two shards
      // both containing "report.json" must not overwrite each other.
      const flattened = name.replace(/[\\/]+/g, '-').replace(/[^\w.-]/g, '_');
      const base = `run-${run.id}-${flattened}`;
      const reportPath = path.join(outDir, base);
      await fs.writeFile(reportPath, bytes);
      const meta = {
        runId: String(run.id),
        commit: run.head_sha,
        timestamp: run.run_started_at ?? run.created_at,
      };
      await fs.writeFile(reportPath.replace(/\.json$/, '.meta.json'), JSON.stringify(meta, null, 2));
      reportsWritten += 1;
      log(`run ${run.id}: wrote ${base}`);
    }
  }
  return { reportsWritten };
}
