// packages/engine/src/check/propagation-teeth.ts
//
// PROOF-007: the pure cross-site propagation tooth. A rule change requires EVERY
// bound (verifying-tagged) site to re-prove green; a PARTIAL update — one site
// fixed, another still red — fails the gate. Two exports:
//
//   changedRules(base, change)   — the base→change content diff: change reqs
//                                   whose matching base req exists AND whose
//                                   `statement` or `changedAtVersion` differs.
//   partialPropagation(...)      — for a CHANGED active rule with ≥2 verifying
//                                   tags, map each through `correlateTag`; the
//                                   MIXED `anyPass && !allPass` case → ONE
//                                   error `PARTIAL_PROPAGATION`.
//
// Complementarity with UNPROVEN_REQ (no double-diagnosis, mirrors
// proven.ts:180-190): PROOF-002 `UNPROVEN_REQ` owns "NO verifying tag passes"
// (all-fail / all-absent). PROOF-007 owns strictly the MIXED case. All-pass is
// silent (fully propagated); all-fail is silent HERE (UNPROVEN_REQ's business).
// The two therefore never fire on the same rule/results input.
//
// Reuses the Phase 19 correlator directly — `correlateTag` (check/proven.ts) is
// the ONE deterministic tag→testcase join; this module never re-implements path
// correlation. `changedRules` works on `SpecRequirement[]` (needs the JSON
// field names `statement` / `changedAtVersion`); `verifyingTags` are storage
// `Tag[]` pre-filtered to `kind === "verifies"` (guarded defensively here).
//
// Off-by-default seam (mirrors check/proven.ts): a side-effect-free projection
// computed at check time ONLY when `--base` AND `--results` are supplied; never
// routed through `validateStructure` / `parse_diagnostics`, so it cannot perturb
// `build_id`, the cold-rebuild byte-identity, or the inverted-CI baseline
// (GATE-04 by construction). Rows in, `Diagnostic[]` out, NO sort — downstream
// `sortDiagnostics` (format.ts) owns ordering (Pitfall 3).
//
// D-08 grep-fence: this file imports no SQLite runtime — no Storage, no DB.

import type { Diagnostic, SpecRequirement, Tag } from "@spec-engine/shared";
import { DiagnosticCode } from "@spec-engine/shared";
import type { TestCaseResult } from "../results/junit";
import { correlateTag } from "./proven";

/**
 * Return the change reqs whose matching base req EXISTS and whose `statement`
 * or `changedAtVersion` differs — "the rule changed, so every bound site must
 * re-prove". A change-only id (no base match) is NOT a change (nothing to
 * propagate against). Pure: never mutates inputs, no I/O, no sort.
 */
export function changedRules(
  base: readonly SpecRequirement[],
  change: readonly SpecRequirement[],
): SpecRequirement[] {
  const baseById = new Map(base.map((r) => [r.id, r]));
  return change.filter((c) => {
    const b = baseById.get(c.id);
    return (
      b !== undefined && (b.statement !== c.statement || b.changedAtVersion !== c.changedAtVersion)
    );
  });
}

/**
 * Emit ONE error-severity `PARTIAL_PROPAGATION` per CHANGED active rule with ≥2
 * verifying tags where SOME correlated tests passed and some did not
 * (`anyPass && !allPass`).
 *
 * `status` is the RAW authored JSON string (lowercase — domain.ts): only
 * `"active"` rules self-gate here (exact match — a non-active rule cannot be a
 * partial propagation). A changed rule with <2 verifying tags is silent
 * ("partial" needs ≥2 bound sites). All-pass → silent; all-fail/all-absent →
 * silent (UNPROVEN_REQ owns those — no double-diagnosis).
 *
 * `verifyingTags` are expected pre-filtered to `kind === "verifies"`; we still
 * guard defensively. Pure: never mutates inputs, no I/O, and does NOT sort.
 */
// @spec PROOF-007
export function partialPropagation(
  changed: readonly SpecRequirement[],
  verifyingTags: readonly Tag[],
  results: readonly TestCaseResult[],
  relPathById: (id: string) => string | null,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const r of changed) {
    // Exact raw-status match — only active rules gate (WR-02 discipline).
    if (r.status !== "active") continue;

    const tags = verifyingTags.filter((t) => t.req_id === r.id && t.kind === "verifies");
    // "Partial" only has meaning across ≥2 bound sites.
    if (tags.length < 2) continue;

    const verdicts = tags.map((t) => correlateTag(t, results));
    const anyPass = verdicts.some((v) => v === "pass");
    const allPass = verdicts.every((v) => v === "pass");
    // MIXED only: all-pass is fully propagated (silent); all-fail/all-absent is
    // UNPROVEN_REQ's business (silent here — no double-diagnosis).
    if (anyPass && !allPass) {
      out.push({
        code: DiagnosticCode.PARTIAL_PROPAGATION,
        source_file: relPathById(r.id),
        line: 0,
        repo: null,
        req_id: r.id,
        detail: `${r.id} changed but only some bound sites re-proved green — a verifying tag failed or had no correlated test result; every verifying tag must pass`,
        severity: "error",
      });
    }
  }
  return out;
}
