// The reasons are decided in declaration order and printed verbatim in
// `spec gate` text and --json output: adding, removing, or reordering one
// breaks the CLI contract.

import type { Repo, Requirement, RequirementStatus } from "./storage";

export type GateReason =
  | "PASS"
  | "NOT_FOUND"
  | "DRAFT"
  | "SUPERSEDED"
  | "DEPRECATED"
  | "VERSION_PIN";

/**
 * `status` and `changed_at_version` are null only for NOT_FOUND.
 * `pinned_spec_version` is never null: the caller screens unknown repos first.
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

/** `repo` is not nullable: the caller exits 2 on an unknown repo before calling. */
export interface ClassifyInput {
  req: Requirement | null;
  repo: Repo;
  requestedReqId: string;
  requestedRepoName: string;
}
