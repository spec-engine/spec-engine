// Computed only when `--base` supplies a base ref, after `runIndex`, so it
// never moves `build_id`. Rows are returned unsorted: `sortDiagnostics` owns
// ordering.

import type { Diagnostic, SpecRequirement } from "@spec-engine/shared";
import { DiagnosticCode } from "@spec-engine/shared";

// `line` is 0: SpecRequirement carries no source line, matching
// validateDomainFile's normalization.
// @spec CHCK-023
export function requirementRemoved(
  baseReqs: readonly SpecRequirement[],
  changeReqs: readonly SpecRequirement[],
  relPathById: (id: string) => string | null,
): Diagnostic[] {
  const changeIds = new Set<string>(changeReqs.map((r) => r.id));

  const out: Diagnostic[] = [];
  for (const b of baseReqs) {
    if (changeIds.has(b.id)) continue;

    // The supersession exemption applies only to an entry Active at the base.
    // A non-Active entry is history whose successor edge predates the change;
    // honoring it would make pruning history silent (guard/losses.ts holds
    // the same line).
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
