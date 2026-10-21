// The branch order is load-bearing: a Superseded or Deprecated requirement
// that is also behind the member's pin must report its status, never
// VERSION_PIN. The retirement is the defect; the version skew is a symptom.

import type { ClassifyInput, GateOutcome } from "@spec-engine/shared";

/**
 * Throws if `input.repo` is null: the caller screens unknown repos to exit 2
 * first, and a throw turns a skipped screen into a crash rather than a
 * silently wrong PASS.
 */
export function classifyGate(input: ClassifyInput): GateOutcome {
  const { req, repo, requestedReqId, requestedRepoName } = input;

  if (repo === null || repo === undefined) {
    throw new Error(
      `classifyGate: repo is null for requestedRepoName=${requestedRepoName}, ` +
        `requestedReqId=${requestedReqId} — CLI must screen unknown repos to ` +
        `exit 2 before calling classifyGate`,
    );
  }

  const pin = repo.pinned_spec_version;

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

  // @spec GATE-009
  if (req.status === "Deprecated") {
    return {
      pass: false,
      reason: "DEPRECATED",
      repo: requestedRepoName,
      req_id: requestedReqId,
      detail: `Requirement ${requestedReqId} is Deprecated — it is end-of-life with no successor; do not build against it`,
      status: req.status,
      changed_at_version: req.changed_at_version,
      pinned_spec_version: pin,
    };
  }

  // Strict greater-than, so pin equality passes: the drift view in
  // packages/shared/src/schema.ts is the canonical comparison and this must
  // agree with it at the boundary.
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
