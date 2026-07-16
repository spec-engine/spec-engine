// packages/engine/src/gate/classify.ts
//
// Pure decision function for `spec gate <repo> <KEY-NNN>` (GATE-01 /
// GATE-02). Given an already-resolved `(req | null, repo, names)` shape,
// returns a fully-populated GateOutcome. No I/O, no Storage, no SQL —
// the storage seam (plan 06-01's `getRepo`, the existing `getRequirement`)
// hands the classifier already-typed rows; this file is the pure decision
// engine the CLI command (plan 06-03) composes around.
//
// DECISION-ORDER CONTRACT (LOCKED BY TEST 6 in gate-classify.test.ts):
//   NOT_FOUND → DRAFT → SUPERSEDED → VERSION_PIN → PASS
//
// The order matters: a Superseded requirement that is ALSO behind the
// member's pin (changed_at_version exceeds pinned_spec_version) MUST
// surface SUPERSEDED, never VERSION_PIN. Superseded is the structural
// defect (the requirement was retired); the version skew is a
// downstream symptom. Reordering these branches breaks ROADMAP
// Success Criterion #1 and Pitfall 3.
//
// VERSION_PIN PREDICATE — STRICT GREATER-THAN ONLY (see line ~111):
// Equality (changed_at_version === pinned_spec_version) is PASS. This
// mirrors `packages/shared/src/schema.ts:188` byte-identically — the
// drift VIEW WHERE clause is the canonical comparison and the
// classifier MUST agree at the boundary (Pitfall 5 / T-06-02-01).
//
// DEFENSIVE NULL-REPO THROW:
//   If `repo === null` we throw, never return — the CLI in plan 06-03
//   MUST screen unknown repos to exit 2 BEFORE calling classifyGate.
//   This is the contract Test 8 enforces.
//
// D-08 grep-fence: this file does NOT import `bun:sqlite`. DB access
// goes exclusively through the Storage interface from @spec-engine/shared.

import type { ClassifyInput, GateOutcome } from "@spec-engine/shared";

/**
 * Classify a single `spec gate <repo> <req_id>` request. Returns a
 * fully-populated GateOutcome with every field set (no `undefined`,
 * explicit `null` for the NOT_FOUND case).
 *
 * Throws if `input.repo` is null — the caller MUST screen unknown
 * repos to exit 2 BEFORE invoking. See Test 8 / Pitfall 8.
 */
export function classifyGate(input: ClassifyInput): GateOutcome {
  const { req, repo, requestedReqId, requestedRepoName } = input;

  // Defensive null-repo guard. Caller in plan 06-03 screens this case
  // (unknown repo → exit 2 with a "no such repo" diagnostic) BEFORE
  // calling classifyGate. Throwing here turns "skipped that check"
  // into a loud crash rather than a silently wrong PASS.
  if (repo === null || repo === undefined) {
    throw new Error(
      `classifyGate: repo is null for requestedRepoName=${requestedRepoName}, ` +
        `requestedReqId=${requestedReqId} — CLI must screen unknown repos to ` +
        `exit 2 before calling classifyGate`,
    );
  }

  const pin = repo.pinned_spec_version;

  // --- Branch 1: NOT_FOUND ------------------------------------------------
  if (req === null) {
    return {
      pass: false,
      reason: "NOT_FOUND",
      repo: requestedRepoName,
      req_id: requestedReqId,
      detail: `Requirement ${requestedReqId} not found in the spec index`,
      status: null,
      changed_at_version: null,
      pinned_spec_version: pin,
    };
  }

  // --- Branch 2: DRAFT ----------------------------------------------------
  if (req.status === "Draft") {
    return {
      pass: false,
      reason: "DRAFT",
      repo: requestedRepoName,
      req_id: requestedReqId,
      detail: `Requirement ${requestedReqId} is Draft — not yet approved for consumption`,
      status: req.status,
      changed_at_version: req.changed_at_version,
      pinned_spec_version: pin,
    };
  }

  // --- Branch 3: SUPERSEDED -----------------------------------------------
  // MUST come BEFORE VERSION_PIN. Test 6 locks this ordering: a
  // Superseded req that ALSO has changed_at_version exceeding the pin
  // still reports SUPERSEDED, never VERSION_PIN.
  if (req.status === "Superseded") {
    const supBy = req.superseded_by ?? "?";
    return {
      pass: false,
      reason: "SUPERSEDED",
      repo: requestedRepoName,
      req_id: requestedReqId,
      detail: `Requirement ${requestedReqId} is Superseded by ${supBy} — migrate the reference`,
      status: req.status,
      changed_at_version: req.changed_at_version,
      pinned_spec_version: pin,
    };
  }

  // --- Branch 4: VERSION_PIN ---------------------------------------------
  // Strict greater-than, mirror schema.ts:188 byte-identically.
  // Equality is PASS — Pitfall 5 / T-06-02-01.
  if (req.changed_at_version > pin) {
    return {
      pass: false,
      reason: "VERSION_PIN",
      repo: requestedRepoName,
      req_id: requestedReqId,
      detail:
        `Requirement ${requestedReqId} changed at @${req.changed_at_version} ` +
        `but ${requestedRepoName} is pinned at @${pin} — bump the pin or accept the drift`,
      status: req.status,
      changed_at_version: req.changed_at_version,
      pinned_spec_version: pin,
    };
  }

  // --- Branch 5: PASS -----------------------------------------------------
  // Active + req.changed_at_version <= pin. Boundary equality lands here.
  return {
    pass: true,
    reason: "PASS",
    repo: requestedRepoName,
    req_id: requestedReqId,
    detail:
      `Requirement ${requestedReqId} is Active at @${req.changed_at_version} ` +
      `and ${requestedRepoName} is pinned at @${pin}`,
    status: req.status,
    changed_at_version: req.changed_at_version,
    pinned_spec_version: pin,
  };
}
