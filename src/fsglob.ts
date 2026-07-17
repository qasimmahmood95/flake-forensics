import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Minimal glob support so the CLI behaves the same on Windows (whose shells
 * do not expand wildcards) and POSIX. Supports `*`, `?` and `**`.
 */

const MAGIC_RE = /[*?]/;

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more directories; trailing `**` matches anything.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += (ch ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Directories that never contain user CI reports; recursing into them makes
 *  `**` patterns slow and noisy. */
const SKIP_DIRS = new Set(['node_modules', '.git']);

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

async function expandGlob(pattern: string): Promise<string[]> {
  // path.join-based walk output never carries a leading "./", so strip it
  // from the pattern too or "./reports/*.json" would match nothing.
  const posixPattern = toPosix(pattern).replace(/^(\.\/)+/, '');
  const firstMagic = posixPattern.search(MAGIC_RE);
  const lastSlashBeforeMagic = posixPattern.lastIndexOf('/', firstMagic);
  const base = lastSlashBeforeMagic >= 0 ? posixPattern.slice(0, lastSlashBeforeMagic) : '.';
  const re = globToRegExp(posixPattern);

  const files: string[] = [];
  try {
    await walk(base, files);
  } catch {
    return [];
  }
  return files.filter((f) => re.test(toPosix(f)));
}

/**
 * Resolve CLI inputs into a list of report files. Each input may be a
 * directory (all `*.json` inside, excluding `*.meta.json` sidecars), a glob
 * pattern, or an explicit file path.
 */
export async function resolveInputs(inputs: string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const input of inputs) {
    if (MAGIC_RE.test(input)) {
      for (const f of await expandGlob(input)) {
        files.add(path.resolve(f));
      }
      continue;
    }
    const stat = await fs.stat(input);
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(input)) {
        if (name.endsWith('.json') && !name.endsWith('.meta.json')) {
          files.add(path.resolve(input, name));
        }
      }
    } else {
      files.add(path.resolve(input));
    }
  }
  return [...files].filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json')).sort();
}
