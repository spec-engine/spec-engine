// packages/engine/src/check/removed.ts
//
// GUARD-010: pure detector for "requirement removed" — an id present in the base
// ref that is absent from the change with no approved supersession. A
// requirement can no longer silently vanish: dropping it from the JSON without
// an accompanying supersession is an error the trusted-red gate refuses.
//
// Off-by-default seam (mirrors check/unsourced.ts): a side-effect-free
// projection over already-parsed SpecRequirement[]. It is computed at check
// time ONLY when `--base` supplies the base ref; it is a post-runIndex
// projection so it never perturbs `build_id` or the cold-rebuild byte-identity
// (GATE-04). Never materialized, never routed through the parse_diagnostics
// store.
//
// Mirrors the pure-function pattern of check/unsourced.ts: rows in, value out,
// no Storage, no I/O.
//
// D-08 grep-fence: this file imports no SQLite runtime — no Storage, no DB.

import type { Diagnostic, SpecRequirement } from "@spec-engine/shared";
import { DiagnosticCode } from "@spec-engine/shared";

/**
 * Return one ERROR-severity Diagnostic per base requirement that is absent from
 * the change with no approved supersession in EITHER direction:
 *
 *   (a) the base req's own `supersededBy` points at an id that SURVIVES in the
 *       change (BILLING-001 removed while BILLING-009 survives), or
 *   (b) some surviving change req declares `supersedes === b.id`.
 *
 * `source_file` is populated from the supplied `relPathById(id)` mapper (the
 * base domain path); `line` is 0 — SpecRequirement carries no source line,
 * matching validateDomainFile's line:0 normalization.
 *
 * Pure: never mutates its inputs, performs no I/O, builds no SQL. Does NOT sort
 * the result — `renderDiagnostics` / `sortDiagnostics` (format.ts) re-sorts the
 * whole array downstream (Pitfall 3).
 */
// @spec GUARD-010
export function requirementRemoved(
  baseReqs: readonly SpecRequirement[],
  changeReqs: readonly SpecRequirement[],
  relPathById: (id: string) => string | null,
): Diagnostic[] {
  const changeIds = new Set<string>(changeReqs.map((r) => r.id));

  const out: Diagnostic[] = [];
  for (const b of baseReqs) {
    // Still present in the change → not removed.
    if (changeIds.has(b.id)) continue;

    // The supersession exemption applies ONLY to an entry that was Active at
    // the base. A non-Active base entry (superseded/deprecated/draft) is
    // history, and its successor edge existed BEFORE the change — honoring it
    // here would make pruning history silent (the same hole guard/losses.ts
    // closed: GUARD-011).
    const activeAtBase = (b.status ?? "").toLowerCase() === "active";
    const exempt =
      activeAtBase &&
      ((b.supersededBy != null && changeIds.has(b.supersededBy)) ||
        changeReqs.some((y) => y.supersedes === b.id));
    if (exempt) continue;

    out.push({
      code: DiagnosticCode.REQUIREMENT_REMOVED,
      source_file: relPathById(b.id),
      line: 0,
      repo: null,
      req_id: b.id,
      detail: activeAtBase
        ? `${b.id} was present in the base ref but is absent from the change with no approved supersession`
        : `${b.id} (${b.status}) was present in the base ref but is absent from the change — a requirement is never deleted, and its history is the record`,
      severity: "error",
    });
  }

  return out;
}
