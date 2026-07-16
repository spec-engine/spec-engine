// packages/engine/src/check/unsourced.ts
//
// USRC-01 / USRC-03: pure detector for "unsourced changes" — a SUPERSEDED
// requirement whose own provenance carries NO `supersedes-via` issue. The
// spec changed (it was superseded) but no tracker issue records why, so the
// change is unsourced.
//
// Off-by-default seam (Phase 14 rationale): this is a side-effect-free
// projection over already-fetched rows. It is NOT routed through
// `validateStructure` / the `parse_diagnostics` store (which are
// unconditionally ON and would perturb `build_id`, the cold-rebuild
// byte-identity, and the 6-row inverted-CI baseline). The Wave-2 CLI caller
// computes it at check time ONLY when `--unsourced-change` is passed.
//
// Mirrors the pure-function pattern of check/format.ts: rows in, value out,
// no Storage, no I/O.
//
// D-08 grep-fence: this file imports no SQLite runtime — no Storage, no DB.

import type { Diagnostic, ProvenanceRow, Requirement } from "@spec-engine/shared";
import { DiagnosticCode } from "@spec-engine/shared";

/**
 * Return one WARNING-severity Diagnostic per Superseded requirement that
 * carries no `supersedes-via` provenance row keyed on its OWN id.
 *
 * Keying note (locks Open Question 1 / Assumption A1): the `supersedes-via`
 * presence is checked against the SUPERSEDED requirement's own `req_id`. A
 * successor requirement carrying `supersedes-via` does NOT clear the
 * superseded one — the superseded req is the planted defect.
 *
 * Pure: never mutates its inputs, performs no I/O, builds no SQL. Does NOT
 * sort the result — `renderDiagnostics` / `sortDiagnostics` (format.ts)
 * re-sorts the whole array downstream (Pitfall 3).
 */
export function unsourcedChanges(
  requirements: readonly Requirement[],
  provenance: readonly ProvenanceRow[],
): Diagnostic[] {
  // req_ids that have a `supersedes-via` issue recorded against their OWN id.
  const sourced = new Set<string>();
  for (const p of provenance) {
    if (p.role === "supersedes-via") {
      sourced.add(p.req_id);
    }
  }

  const out: Diagnostic[] = [];
  for (const r of requirements) {
    // Belt-and-suspenders for direct unit calls — the Wave-2 caller
    // pre-filters via listRequirements({ status: "Superseded" }).
    //
    // WR-02: the exact `=== "Superseded"` match is DELIBERATE — do NOT relax
    // it into a fuzzy/case-insensitive/trimmed match. A row whose status is a
    // value OUTSIDE the RequirementStatus union (e.g. lowercase "superseded"
    // or "Superseded " with a trailing space) is a planted BAD_STATUS defect:
    // it is intentionally invisible to UNSOURCED_CHANGE because BAD_STATUS
    // already fires on it as its own separate diagnostic. Fuzzy-matching here
    // would double-flag the same defect and re-introduce noise. (Per CLAUDE.md
    // "validate via diagnostics, never DB constraints" — malformed statuses
    // flow through the derived index verbatim and are surfaced, not coerced.)
    if (r.status !== "Superseded") continue;
    if (sourced.has(r.id)) continue;

    out.push({
      code: DiagnosticCode.UNSOURCED_CHANGE,
      source_file: r.source_file,
      line: r.line,
      repo: null,
      req_id: r.id,
      detail: `${r.id} was superseded without a recorded supersedes-via issue`,
      severity: "warning",
    });
  }

  return out;
}
