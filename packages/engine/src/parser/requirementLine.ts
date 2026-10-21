// `JSON.parse` discards source positions, so the line is recovered by
// scanning the raw text for the id's `"id"` key.
//   - An `issues[]` entry's `id` may be requirement-id-shaped. The write seam
//     serializes with `JSON.stringify(_, null, 2)`, putting a requirement's
//     `"id"` at six spaces and an issue's at ten, so the six-space form wins.
//   - Requirements serialize in array order, so the scan keeps a monotonic
//     cursor and never re-matches a line an earlier requirement claimed.
// The needle is a literal substring, never a built RegExp.

/** Six spaces: a requirement's `"id"` depth under `JSON.stringify(_, null, 2)`. */
const SEAM_INDENT = "      ";

/**
 * 0-based index of `id`'s `"id"` line at or after `from`, or -1 when absent.
 *
 * Prefers the write seam's exact indent; falls back to a loose substring match
 * so a hand-written or reformatted file still resolves.
 */
export function findRequirementIdLine(rawLines: string[], id: string, from = 0): number {
  const needle = `"id": "${id}"`;
  const exact = `${SEAM_INDENT}${needle}`;
  const start = from > 0 ? from : 0;

  let loose = -1;
  for (let i = start; i < rawLines.length; i++) {
    const line = rawLines[i] ?? "";
    if (line === exact || line === `${exact},`) return i;
    if (loose < 0 && line.includes(needle)) loose = i;
  }
  return loose;
}
