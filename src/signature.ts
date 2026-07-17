import { createHash } from 'node:crypto';
import type { AttemptError } from './types.js';

/**
 * Error-signature normalisation.
 *
 * Goal: two failures caused by the same defect must map to the same
 * signature even when volatile details (ports, ids, durations, values)
 * differ — so one root cause spanning 40 tests reads as one cluster.
 *
 * signature = hash( messageTemplate + topApplicationFrame )
 */

export interface Signature {
  /** Short stable id (first 12 hex chars of sha1). */
  id: string;
  template: string;
  frame: string;
}

/** Matches ANSI colour/style escape sequences without embedding a control char in source. */
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');

/**
 * Token replacement rules, applied globally and IN THIS ORDER (order matters:
 * URLs must be collapsed before addresses, addresses before bare numbers,
 * and so on — otherwise a later rule chews up part of an earlier pattern).
 */
const TOKEN_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // 1. ISO timestamps: 2026-05-03T09:00:00.123Z
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TIMESTAMP>'],
  // 2. UUIDs
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>'],
  // 3. Long hex identifiers (commits, request ids) — 8+ chars
  [/\b[0-9a-f]{8,40}\b/gi, '<HEX>'],
  // 4. URLs (before host:port so the scheme+host is not shredded)
  [/https?:\/\/[^\s'")]+/g, '<URL>'],
  // 5. ip:port and localhost:port
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<ADDR>'],
  [/\blocalhost:\d+\b/g, '<ADDR>'],
  // 6. Multi-segment filesystem paths (posix or Windows, 2+ separators).
  //    No spaces inside segments: with spaces allowed, prose like
  //    "GET /api/users returned 500" would be swallowed whole.
  [/(?:[A-Za-z]:)?(?:[\\/][\w.@-]+){2,}/g, '<PATH>'],
  // 7. Durations: 15000ms, 1.5s, 30s
  [/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g, '<DURATION>'],
  // 8. Any remaining number
  [/\b\d+(?:\.\d+)?\b/g, '<N>'],
];

const MAX_TEMPLATE_LENGTH = 240;
const MAX_TEMPLATE_LINES = 5;

/**
 * Normalise a raw error message into a template.
 *
 * Pipeline (each step documented in the README):
 *  1. strip ANSI colour codes
 *  2. drop everything from "Call log:" onward (per-attempt noise)
 *  3. keep at most the first 5 non-empty lines
 *  4. replace `Expected:` / `Received:` values with <VAL> (assertion values
 *     are volatile; the assertion SHAPE is the signal)
 *  5. apply the ordered token rules (timestamps, uuids, hex, urls,
 *     addresses, paths, durations, numbers)
 *  6. collapse whitespace, trim, cap at 240 chars
 *
 * Quoted strings and selectors are deliberately KEPT — they are structural —
 * but token rules run inside them, so locator('#row-42') -> locator('#row-<N>').
 */
export function normalizeErrorMessage(raw: string): string {
  const noAnsi = raw.replace(ANSI_RE, '');

  const lines: string[] = [];
  for (const line of noAnsi.split(/\r?\n/)) {
    if (/^\s*call log:?\s*$/i.test(line)) break;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    lines.push(trimmed);
    if (lines.length >= MAX_TEMPLATE_LINES) break;
  }

  let template = lines
    .map((line) => line.replace(/^((?:Expected|Received)\b[^:]*:)\s.*$/, '$1 <VAL>'))
    .join(' ');

  for (const [re, replacement] of TOKEN_RULES) {
    template = template.replace(re, replacement);
  }

  template = template.replace(/\s+/g, ' ').trim();
  if (template.length > MAX_TEMPLATE_LENGTH) {
    template = template.slice(0, MAX_TEMPLATE_LENGTH);
  }
  return template.length > 0 ? template : '<empty-message>';
}

/** Stack frames from these locations are runner plumbing, not the app. */
const IGNORED_FRAME_RE = /node_modules|node:internal|node:async_hooks|[\\/]playwright(?:-core)?[\\/]/;

const FRAME_RE = /^\s*at\s+(?:async\s+)?(?:(.+?)\s+\()?([^()]+?):(\d+):(\d+)\)?\s*$/;

/** Path segments that mark the start of a repo-relative path. */
const REPO_MARKERS = ['tests', 'test', 'e2e', 'specs', 'spec', 'src'];

function normalizeFramePath(rawPath: string): string {
  let p = rawPath.replace(/\\/g, '/');
  p = p.replace(/^[A-Za-z]:/, '');
  p = p.replace(/^file:\/\//, '');
  const segments = p.split('/').filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg !== undefined && REPO_MARKERS.includes(seg)) {
      return segments.slice(i).join('/');
    }
  }
  // No marker found: keep at most the last 3 segments.
  return segments.slice(-3).join('/');
}

/**
 * First stack frame that belongs to the application (skips node_modules,
 * node internals and Playwright's own code). Line and column are DROPPED —
 * they shift with every commit — the file and function name are kept.
 */
export function topApplicationFrame(stack: string | undefined): string {
  if (stack === undefined || stack.length === 0) return '<no-stack>';
  for (const line of stack.replace(ANSI_RE, '').split(/\r?\n/)) {
    const match = FRAME_RE.exec(line);
    if (match === null) continue;
    const fn = match[1];
    const rawPath = match[2];
    if (rawPath === undefined || IGNORED_FRAME_RE.test(rawPath)) continue;
    return `${normalizeFramePath(rawPath)}#${fn ?? '<anonymous>'}`;
  }
  return '<no-stack>';
}

export function computeSignature(error: AttemptError): Signature {
  const template = normalizeErrorMessage(error.message);
  const frame = topApplicationFrame(error.stack);
  const id = createHash('sha1').update(`${template}\n${frame}`).digest('hex').slice(0, 12);
  return { id, template, frame };
}
