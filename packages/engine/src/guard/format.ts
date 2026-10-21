// @spec GUARD-020
// @spec GUARD-021
//
// The text blocks are written in the second person so a coding agent can relay
// them to its user verbatim. A requirement's losses aggregate into one block so
// the implementation and test clauses read as one sentence.

import type { RenderMode } from "../constants";
import type { Loss } from "./losses";

/** An escape, never a raw astral character: the engine-src no-external-net CI
 *  fence greps every src file and would mis-flag an astral byte as binary. */
const STOP = "\u{1F6D1}";

/** A null req_id (SPEC_FILE_DELETED) sorts as the empty string, ahead of every
 *  named requirement. */
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

function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function deletesClause(losses: readonly Loss[]): string {
  const parts: string[] = [];
  if (losses.some((l) => l.kind === "REQUIREMENT_REMOVED")) parts.push("the requirement itself");
  const impl = losses.find((l) => l.kind === "IMPL_LOST");
  if (impl !== undefined) parts.push(`its only implementation (${impl.file}:${impl.line})`);
  if (losses.some((l) => l.kind === "VERIFY_LOST")) parts.push("its verifying test");
  return joinClauses(parts);
}

function requirementBlock(reqId: string, losses: readonly Loss[]): string {
  return (
    `${STOP} spec-guard: ${reqId} is Active and this change deletes ${deletesClause(losses)}. ` +
    "Requirements are superseded, never deleted. " +
    `Either run \`spec supersede ${reqId}\` with a successor, or run ` +
    `\`spec deprecate ${reqId} --reason "..."\` to end it with a recorded reason.`
  );
}

function fileBlock(loss: Loss): string {
  return (
    `${STOP} spec-guard: the canonical spec file ${loss.file} was deleted. ` +
    "Requirements are superseded, never deleted — restore the file or supersede " +
    "its requirements into another domain before removing it."
  );
}

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

export function renderGuard(losses: readonly Loss[], mode: RenderMode, ref: string): string {
  const sorted = sortLosses(losses);
  if (mode === "json") return JSON.stringify(sorted);
  if (sorted.length === 0) {
    return `✓ spec guard: no requirements about to be lost against ${ref}`;
  }
  return blockMessages(sorted).join("\n\n");
}
