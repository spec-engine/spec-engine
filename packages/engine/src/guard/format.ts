// packages/engine/src/guard/format.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec GUARD-009
//
// The pure formatter for `spec guard`. Losses in, string out — no
// I/O, no Storage, no bun:sqlite (D-08 fence). Two modes:
//
//   json — the machine contract: `JSON.stringify` of the deterministically
//          sorted rows, no indentation, no trailing newline. Byte-stable across
//          runs so it is safe to diff/snapshot (mirrors propagation/format.ts).
//
//   text — the PRODUCT SURFACE. One `<STOP> spec-guard:` block per affected
//          requirement (STOP = the U+1F6D1 stop-sign glyph), written in the
//          second person so a coding agent can relay it to its user verbatim.
//          The copy is fixed:
//
//          "<STOP> spec-guard: BILLING-009 is Active and this change deletes its
//           only implementation (src/billing.ts:12) and its verifying test.
//           Requirements are superseded, never deleted. Either run
//           `spec supersede BILLING-009` with a successor, or stop and ask the
//           user whether this requirement should die."
//
//          Per-requirement losses (REQUIREMENT_REMOVED / IMPL_LOST / VERIFY_LOST) are
//          AGGREGATED into a single block so the "...implementation ... and its
//          verifying test" clause reads as one sentence. SPEC_FILE_DELETED is
//          file-level and gets its own block.
//
// SOURCE-ASCII: the stop-sign is emitted via the STOP escape below, never a raw
// astral character in this file, so the engine-src no-external-net CI fence
// (which cats + greps every src file) never sees an astral byte and mis-flags
// the stream as binary. The rendered output byte is identical.

import type { RenderMode } from "../constants";
import type { Loss } from "./losses";

/** The U+1F6D1 stop-sign that opens every block, as a source-ASCII escape (see
 *  the SOURCE-ASCII note above) so this file carries no raw astral byte. */
const STOP = "\u{1F6D1}";

/**
 * Deterministically sort losses by (req_id, kind, file, line). Returns a NEW
 * array — never mutates input — so --json output is byte-stable and
 * snapshot-lockable. A null req_id (SPEC_FILE_DELETED) sorts as the empty
 * string, deterministically ahead of every named requirement.
 */
export function sortLosses(losses: readonly Loss[]): Loss[] {
  return [...losses].sort((a, b) => {
    const byReq = (a.req_id ?? "").localeCompare(b.req_id ?? "");
    if (byReq !== 0) return byReq;
    const byKind = a.kind.localeCompare(b.kind);
    if (byKind !== 0) return byKind;
    const byFile = a.file.localeCompare(b.file);
    if (byFile !== 0) return byFile;
    return a.line - b.line;
  });
}

/** Join clauses with natural-language conjunction: "a", "a and b",
 *  "a, b, and c". Reproduces the fixed block copy for the impl+test case. */
function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** The `deletes <what>` clause for one requirement's aggregated losses, in the
 *  fixed order: the requirement itself, then its implementation, then its test. */
function deletesClause(losses: readonly Loss[]): string {
  const parts: string[] = [];
  if (losses.some((l) => l.kind === "REQUIREMENT_REMOVED")) parts.push("the requirement itself");
  const impl = losses.find((l) => l.kind === "IMPL_LOST");
  if (impl !== undefined) parts.push(`its only implementation (${impl.file}:${impl.line})`);
  if (losses.some((l) => l.kind === "VERIFY_LOST")) parts.push("its verifying test");
  return joinClauses(parts);
}

/** The fixed product-surface block for one requirement (GUARD-009 copy). */
function requirementBlock(reqId: string, losses: readonly Loss[]): string {
  return (
    `${STOP} spec-guard: ${reqId} is Active and this change deletes ${deletesClause(losses)}. ` +
    "Requirements are superseded, never deleted. " +
    `Either run \`spec supersede ${reqId}\` with a successor, ` +
    "or stop and ask the user whether this requirement should die."
  );
}

/** The file-level block for a deleted canonical spec file (SPEC_FILE_DELETED). */
function fileBlock(loss: Loss): string {
  return (
    `${STOP} spec-guard: the canonical spec file ${loss.file} was deleted. ` +
    "Requirements are superseded, never deleted — restore the file or supersede " +
    "its requirements into another domain before removing it."
  );
}

/** Build the human blocks: one aggregated block per requirement (in sorted id
 *  order), then one block per deleted spec file. */
function blockMessages(sorted: readonly Loss[]): string[] {
  const byReq = new Map<string, Loss[]>();
  const fileLosses: Loss[] = [];
  for (const loss of sorted) {
    if (loss.req_id === null) {
      fileLosses.push(loss);
      continue;
    }
    const arr = byReq.get(loss.req_id) ?? [];
    arr.push(loss);
    byReq.set(loss.req_id, arr);
  }
  const out: string[] = [];
  for (const [reqId, losses] of byReq) out.push(requirementBlock(reqId, losses));
  for (const loss of fileLosses) out.push(fileBlock(loss));
  return out;
}

/**
 * Render the losses. `ref` names the base ref for the clean-tree confirmation.
 *
 * json mode: byte-stable `JSON.stringify` of the sorted rows (`[]` when clean).
 * text mode: the `<STOP> spec-guard:` blocks joined by a blank line, or a single
 *   `✓` confirmation line when the tree is clean.
 */
export function renderGuard(losses: readonly Loss[], mode: RenderMode, ref: string): string {
  const sorted = sortLosses(losses);
  if (mode === "json") return JSON.stringify(sorted);
  if (sorted.length === 0) {
    return `✓ spec guard: no requirements about to be lost against ${ref}`;
  }
  return blockMessages(sorted).join("\n\n");
}
