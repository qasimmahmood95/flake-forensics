/**
 * Compare two timestamp strings chronologically. Parses to epoch ms so that
 * mixed representations of the same instant (`...+02:00` vs `...Z`) order
 * correctly; falls back to string comparison when either side is unparsable.
 */
export function compareTimestamps(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  return a.localeCompare(b);
}
