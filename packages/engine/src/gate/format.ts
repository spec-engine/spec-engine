import type { GateOutcome } from "@spec-engine/shared";
import type { RenderMode } from "../constants";

/**
 * JSON field order is the insertion order `classifyGate` builds each branch
 * with, which follows the GateOutcome declaration; reordering those literals
 * changes the bytes. No trailing newline in either mode: the caller's
 * console.log adds it.
 */
export function renderGate(outcome: GateOutcome, mode: RenderMode): string {
  if (mode === "json") {
    return JSON.stringify(outcome);
  }
  return `${outcome.reason}: ${outcome.repo} ${outcome.req_id} — ${outcome.detail}`;
}
