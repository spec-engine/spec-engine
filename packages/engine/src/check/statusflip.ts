// packages/engine/src/check/statusflip.ts
//
// GOV-02: the pure status-flip approval gate. A requirement whose status flips
// from an active/draft state to `superseded`/`retired` on a CODEOWNERS-owned
// spec path — with NO domain owner present in the approver set — is an
// unapproved governance change. Emits ONE `UNAPPROVED_STATUS_FLIP` per flip.
//
// TWO-TIER severity (20-CONTEXT USER DECISION): the SAME finding is
// `severity: "warning"` by DEFAULT (surfaced as a PR comment/annotation, does
// NOT fail the gate) and `severity: "error"` ONLY under strict
// (--require-owner-approval, fails the build). The severity is a runtime field
// picked from the `strict` argument — there is exactly ONE diagnostic code, not
// two (diagnostics.ts UNAPPROVED_STATUS_FLIP).
//
// Trust boundary (T-20-04): `approvedBy` is an OPAQUE input. The detector never
// derives approval from git authorship (spoofable by rebase) — the CI workflow
// populates it from the trusted PR-reviews API (documented in 20-03).
// FAIL-CLOSED: an empty `approvedBy` means NO approver, so every qualifying flip
// fires. Do NOT default `approvedBy` to a truthy value.
//
// Owner resolution is DELEGATED to the ReDoS-safe CODEOWNERS grammar from 20-01
// (`ownersForPath`) — this module never re-implements glob matching.
//
// Off-by-default seam (mirrors check/unsourced.ts / check/proven.ts): a
// side-effect-free projection over already-parsed base/change rows, computed at
// check time ONLY when `--base` is supplied; NEVER routed through
// `validateStructure` / the `parse_diagnostics` store, so it cannot perturb
// `build_id`, the cold-rebuild byte-identity, or the inverted-CI baseline
// (GATE-04 by construction). Rows in, `Diagnostic[]` out, NO sort — downstream
// `sortDiagnostics` (format.ts) owns ordering (Pitfall 3).
//
// D-08 grep-fence: this file imports no SQLite runtime — no Storage, no DB.

import type { Diagnostic, SpecRequirement } from "@spec-engine/shared";
import { DiagnosticCode } from "@spec-engine/shared";
import { type CodeownersRule, ownersForPath } from "./codeowners";

/** Strip a single leading `@` AND lowercase so a CODEOWNERS owner (`@Drea`) and
 *  an approver handle (`drea` / `@drea`) compare equal. GitHub logins are
 *  case-insensitive (WR-02), so a case mismatch between CODEOWNERS and the
 *  PR-reviews-API approver set must not turn an approved flip into an error.
 *  NOTE: a team owner (`@org/team`) still cannot be matched by an individual
 *  approver login — team-membership expansion is deferred CI glue (T-20-04). */
function normalizeHandle(h: string): string {
  return (h.startsWith("@") ? h.slice(1) : h).toLowerCase();
}

/** True iff `change` is a NEW flip INTO a terminal status relative to `base`.
 *  WR-02 exact-match: only a flip INTO `superseded`/`retired` qualifies. A
 *  BAD_STATUS value (e.g. "drft") stays invisible — no fuzzy coercion. A req
 *  not present in base, ALREADY superseded/retired in base, or unchanged is not
 *  a NEW flip → returns false. */
function isNewTerminalFlip(base: string | undefined, change: string): boolean {
  if (change !== "superseded" && change !== "retired") return false;
  if (base === undefined) return false;
  if (base === "superseded" || base === "retired") return false;
  // Only a NEW flip when the base status differs (and was not already terminal).
  return base !== change;
}

/**
 * Emit ONE `UNAPPROVED_STATUS_FLIP` per requirement whose base→change status
 * flips INTO `superseded`/`retired` on a CODEOWNERS-owned spec path without an
 * approving domain owner.
 *
 * `status` is the RAW authored JSON string (lowercase — domain.ts), NOT the
 * Capitalized storage `RequirementStatus`. WR-02 exact-status-match: a target
 * status OUTSIDE {superseded, retired} is a planted BAD_STATUS defect and MUST
 * stay invisible here (BAD_STATUS owns it) — never fuzzy-match. A req that was
 * ALREADY superseded/retired in base is not a NEW flip → silent.
 *
 * Severity is `strict ? "error" : "warning"` — one code, two tiers. Pure: never
 * mutates its inputs, no I/O, and does NOT sort.
 */
export function unapprovedStatusFlip(
  baseReqs: readonly SpecRequirement[],
  changeReqs: readonly SpecRequirement[],
  codeowners: readonly CodeownersRule[],
  approvedBy: readonly string[],
  relPathById: (id: string) => string | null,
  strict: boolean,
): Diagnostic[] {
  // Base status by id, so we can tell a NEW flip from an already-terminal req.
  const baseStatus = new Map<string, string>();
  for (const b of baseReqs) baseStatus.set(b.id, b.status);

  // Normalized approver set (fail-closed: empty stays empty → no approver).
  const approvers = new Set(approvedBy.map(normalizeHandle));

  const out: Diagnostic[] = [];
  for (const c of changeReqs) {
    const cs = c.status;
    // WR-02 exact-match / NEW-flip guard is delegated to isNewTerminalFlip:
    // BAD_STATUS values and already-terminal base rows stay invisible.
    if (!isNewTerminalFlip(baseStatus.get(c.id), cs)) continue;

    const owners = ownersForPath(codeowners, relPathById(c.id) ?? "");
    // Approved iff any normalized domain owner is in the normalized approver set.
    if (owners.some((o) => approvers.has(normalizeHandle(o)))) continue;

    out.push({
      code: DiagnosticCode.UNAPPROVED_STATUS_FLIP,
      source_file: relPathById(c.id),
      line: 0,
      repo: null,
      req_id: c.id,
      detail: `${c.id} was flipped to ${cs} without an approving CODEOWNERS domain owner (owners: ${owners.join(", ")})`,
      severity: strict ? "error" : "warning",
    });
  }

  return out;
}
