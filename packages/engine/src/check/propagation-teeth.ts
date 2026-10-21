// PARTIAL_PROPAGATION owns strictly the mixed case (some bound sites pass,
// some do not). All-fail and all-absent belong to UNPROVEN_REQ, so the two
// never fire on the same input. Tag-to-testcase correlation is `correlateTag`
// in check/proven.ts; this module never re-implements it.
//
// Computed only when `--base` and `--results` are both supplied, and never
// routed through parse diagnostics, so it cannot move `build_id` or the
// planted-fixture baseline. Rows are returned unsorted: `sortDiagnostics`
// owns ordering.

import type { Diagnostic, SpecRequirement, Tag } from "@spec-engine/shared";
import { DiagnosticCode } from "@spec-engine/shared";
import type { TestCaseResult } from "../results/junit";
import { correlateTag } from "./proven";

// A change-only id (no base match) is not a change: there is nothing to
// propagate against.
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

// `status` is the raw authored JSON string (lowercase), so the match is exact.
// `verifyingTags` arrive pre-filtered to `kind === "verifies"`; the filter
// below guards anyway.
// @spec PROOF-013
export function partialPropagation(
  changed: readonly SpecRequirement[],
  verifyingTags: readonly Tag[],
  results: readonly TestCaseResult[],
  relPathById: (id: string) => string | null,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const r of changed) {
    if (r.status !== "active") continue;

    const tags = verifyingTags.filter((t) => t.req_id === r.id && t.kind === "verifies");
    if (tags.length < 2) continue;

    const verdicts = tags.map((t) => correlateTag(t, results));
    const anyPass = verdicts.some((v) => v === "pass");
    const allPass = verdicts.every((v) => v === "pass");
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
