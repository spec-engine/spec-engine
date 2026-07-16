// packages/engine/src/gate/format.ts
//
// Pure formatter for `spec gate <repo> <KEY-NNN>` (GATE-01 / GATE-02 /
// GATE-04). Takes a `GateOutcome` (the fully-populated decision row
// produced by `classifyGate` — see `gate/classify.ts`) and returns a
// string for stdout. No I/O, no Storage, no `bun:sqlite`. The citty
// command (commands/gate.ts) prints whatever string renderGate returns
// and adds a single console.log newline.
//
// GATE-04: JSON output is byte-stable across consecutive invocations
// against the same DB — the outcome is serialized with no indentation
// and no trailing newline. The GateOutcome shape is a single object
// (NOT an array) — `spec gate` answers one (repo, req) question, so
// the JSON contract is a flat object that `jq -r '.reason'` can drive
// without indexing.
//
// Field order in the JSON output follows the GateOutcome declaration
// order from `packages/shared/src/gate.ts` (pass, reason, repo, req_id,
// detail, status, changed_at_version, pinned_spec_version) — JS object
// insertion order is what `JSON.stringify` emits, and `classifyGate`
// constructs every branch with literal fields in that exact order.
//
// Text mode: a single line of the form
//     <REASON>: <repo> <req_id> — <detail>
// using the U+2014 em-dash literal as the separator (matches the
// project convention for user-facing separators — see EMPTY_CELL in
// resolve/format.ts:35). NO trailing newline; the caller's
// `console.log` adds it. NO columnar alignment — gate output is a
// single decision, not a multi-row table.
//
// Empty/null discipline: `outcome.detail` is guaranteed non-empty by
// `classifyGate` (every branch builds a non-empty detail string). The
// formatter does NOT introduce em-dash placeholder logic for missing
// fields — the contract is "always populated, by construction".
//
// D-08 grep-fence: this file does NOT import bun:sqlite. The GateOutcome
// type comes from @spec-engine/shared (which is itself runtime-free per
// WORK-02).

import type { GateOutcome } from "@spec-engine/shared";
import type { RenderMode } from "../constants";

/**
 * Render a single GateOutcome for stdout.
 *
 * mode="json": single-object serialization with no indentation and no
 *   trailing newline. Byte-stable: same input → identical bytes across
 *   invocations.
 *
 * mode="text": single line `<REASON>: <repo> <req_id> — <detail>`
 *   (e.g., `PASS: api BILLING-009 — Requirement BILLING-009 is Active
 *   at @2 and api is pinned at @2`). NO trailing newline; the caller
 *   adds it via console.log.
 */
export function renderGate(outcome: GateOutcome, mode: RenderMode): string {
  if (mode === "json") {
    return JSON.stringify(outcome);
  }
  // Text mode — single line, U+2014 em-dash separator between the
  // identifier prefix and the human-readable detail. The detail itself
  // is built by classifyGate and is guaranteed non-empty.
  return `${outcome.reason}: ${outcome.repo} ${outcome.req_id} — ${outcome.detail}`;
}
