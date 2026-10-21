// Computed only when `--unsourced-change` is passed and never routed through
// parse diagnostics, so it cannot move `build_id` or the planted-fixture
// baseline. Rows are returned unsorted: `sortDiagnostics` owns ordering.

import type { Diagnostic, ProvenanceRow, Requirement } from "@spec-engine/shared";
import { DiagnosticCode } from "@spec-engine/shared";

// Keyed on the superseded requirement's own id: a successor carrying
// `supersedes-via` does not clear its predecessor.
export function unsourcedChanges(
  requirements: readonly Requirement[],
  provenance: readonly ProvenanceRow[],
): Diagnostic[] {
  const sourced = new Set<string>();
  for (const p of provenance) {
    if (p.role === "supersedes-via") {
      sourced.add(p.req_id);
    }
  }

  const out: Diagnostic[] = [];
  for (const r of requirements) {
    // Exact match on purpose: a malformed status ("superseded", "Superseded ")
    // is BAD_STATUS's defect, and a fuzzy match would flag it twice.
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
