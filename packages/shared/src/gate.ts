// packages/shared/src/gate.ts
//
// Decision vocabulary for `spec gate <repo> <KEY-NNN>` — the rung-3
// approval primitive (GATE-01 / GATE-02). The gate passes iff the
// referenced requirement is Active AND the member's pinned
// spec_version is >= the requirement's `changed_at_version`. Any other
// state produces a typed, machine-readable failure reason.
//
// Lives in `shared/` (not engine/) because a future webapp gate panel
// will render the same outcomes — putting the union here means the CLI
// JSON contract, engine classifier, and webapp renderer all type-check
// against ONE source of truth and can never drift.
//
// 5-MEMBER CONTRACT (DECLARATION ORDER MATTERS — appears verbatim in
// CLI --json output and stdout text mode):
//   PASS | NOT_FOUND | DRAFT | SUPERSEDED | VERSION_PIN
// Any addition or removal here is a breaking change to the CLI + JSON
// output contract. Each literal is also the user-facing diagnostic
// label in `spec gate` stdout — keep them all-caps, ASCII, snake-free.
//
// WORK-02: shared package is runtime-free — this file has zero runtime
// imports (no `bun:sqlite`, no `node:*`). Types only.

import type { Repo, Requirement, RequirementStatus } from "./storage";

/**
 * Machine-readable outcome reason for `spec gate`. Exactly 5 members,
 * in declaration order. Public CLI contract — appears verbatim in
 * --json output and stdout text mode.
 */
export type GateReason = "PASS" | "NOT_FOUND" | "DRAFT" | "SUPERSEDED" | "VERSION_PIN";

/**
 * Fully-populated decision row returned by `classifyGate`. Every field
 * is populated for every reason: `status` and `changed_at_version` are
 * `null` only when `reason === "NOT_FOUND"`; `pinned_spec_version` is
 * never null because `classifyGate` is only invoked with a non-null
 * Repo (the CLI layer screens unknown repos to exit 2 before calling).
 */
export interface GateOutcome {
  pass: boolean;
  reason: GateReason;
  repo: string;
  req_id: string;
  detail: string;
  status: RequirementStatus | null;
  changed_at_version: number | null;
  pinned_spec_version: number;
}

/**
 * Input shape for `classifyGate`. The caller (CLI in plan 06-03) MUST
 * screen unknown repos to exit 2 BEFORE invoking — `repo` is NOT
 * nullable. Passing `null as any` causes `classifyGate` to throw
 * (per Pitfall 8).
 */
export interface ClassifyInput {
  req: Requirement | null;
  repo: Repo;
  requestedReqId: string;
  requestedRepoName: string;
}
