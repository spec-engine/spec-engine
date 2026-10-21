// `approvedBy` is opaque: the CI workflow fills it from the PR-reviews API.
// Approval is never derived from git authorship, which a rebase can spoof.
// Fail-closed: an empty `approvedBy` means no approver, so never default it
// to a truthy value.
//
// Computed only when `--base` is supplied and never routed through parse
// diagnostics, so it cannot move `build_id` or the planted-fixture baseline.
// Rows are returned unsorted: `sortDiagnostics` owns ordering.

import type { Diagnostic, SpecRequirement } from "@spec-engine/shared";
import { DiagnosticCode } from "@spec-engine/shared";
import { type CodeownersRule, ownersForPath } from "./codeowners";

// GitHub logins are case-insensitive. A team owner (`@org/team`) is not
// matched by an individual approver login: team expansion is left to CI.
function normalizeHandle(h: string): string {
  return (h.startsWith("@") ? h.slice(1) : h).toLowerCase();
}

// "retired" is the legacy spelling of "deprecated": accepted on read, never
// written.
const TERMINAL_STATUSES = new Set(["superseded", "deprecated", "retired"]);

// Exact match on purpose: a BAD_STATUS value ("drft") stays invisible here
// because BAD_STATUS owns it.
function isNewTerminalFlip(base: string | undefined, change: string): boolean {
  if (!TERMINAL_STATUSES.has(change)) return false;
  if (base === undefined) return false;
  if (TERMINAL_STATUSES.has(base)) return false;
  return base !== change;
}

// `status` is the raw authored JSON string (lowercase), not the capitalized
// storage `RequirementStatus`.
export function unapprovedStatusFlip(
  baseReqs: readonly SpecRequirement[],
  changeReqs: readonly SpecRequirement[],
  codeowners: readonly CodeownersRule[],
  approvedBy: readonly string[],
  relPathById: (id: string) => string | null,
  strict: boolean,
): Diagnostic[] {
  const baseStatus = new Map<string, string>();
  for (const b of baseReqs) baseStatus.set(b.id, b.status);

  const approvers = new Set(approvedBy.map(normalizeHandle));

  const out: Diagnostic[] = [];
  for (const c of changeReqs) {
    const cs = c.status;
    if (!isNewTerminalFlip(baseStatus.get(c.id), cs)) continue;

    const owners = ownersForPath(codeowners, relPathById(c.id) ?? "");
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
