// @spec GUARD-023
// @spec GUARD-015
// @spec GUARD-016
// @spec GUARD-017
// @spec GUARD-018
// @spec GUARD-028
//
// Pure: no Storage, git, or filesystem. guard/collect.ts gathers the facts, so
// the whole loss taxonomy is unit-testable without a git repo. There is
// deliberately no override comment: a loss is suppressed only by superseding
// or deprecating the requirement in the same change.

import type { SpecRequirement } from "@spec-engine/shared";

export type LossKind = "REQUIREMENT_REMOVED" | "IMPL_LOST" | "VERIFY_LOST" | "SPEC_FILE_DELETED";

/** Platform-relative file and 1-based line of a tag at the base ref. */
export interface TagSite {
  file: string;
  line: number;
}

/** `req_id` is null only for SPEC_FILE_DELETED. `line` is 0 when the loss has
 *  no source line. `detail` is the --json sentence; the human block message is
 *  composed separately in format.ts. */
export interface Loss {
  kind: LossKind;
  req_id: string | null;
  file: string;
  line: number;
  detail: string;
}

/** Plain data, never git or Storage handles, so the classifier stays pure. */
export interface GuardFacts {
  /** Only the SPEC.json files in the change scope. */
  baseReqs: readonly SpecRequirement[];
  baseReqPath: ReadonlyMap<string, string>;
  /** Base tag sites among changed files only; the first site per id wins. */
  baseImplSite: ReadonlyMap<string, TagSite>;
  baseVerifySite: ReadonlyMap<string, TagSite>;
  worktreeReqIds: ReadonlySet<string>;
  worktreeActiveIds: ReadonlySet<string>;
  worktreeSupersedesTargets: ReadonlySet<string>;
  /** Counts across the whole working tree, not just the change scope. */
  worktreeImplCount: ReadonlyMap<string, number>;
  worktreeVerifyCount: ReadonlyMap<string, number>;
  deletedSpecFiles: readonly string[];
}

function isActive(status: string): boolean {
  return status.toLowerCase() === "active";
}

/** Either direction counts. Must stay in step with check/removed.ts's exemption. */
function isSuperseded(base: SpecRequirement, f: GuardFacts): boolean {
  const forward = base.supersededBy != null && f.worktreeReqIds.has(base.supersededBy);
  return forward || f.worktreeSupersedesTargets.has(base.id);
}

function reqDeletedLoss(base: SpecRequirement, f: GuardFacts): Loss {
  return {
    kind: "REQUIREMENT_REMOVED",
    req_id: base.id,
    file: f.baseReqPath.get(base.id) ?? "",
    line: 0,
    detail: `${base.id} was Active at the ref but is absent from the working-tree spec and was not superseded — a requirement is never deleted`,
  };
}

function historyRemovedLoss(base: SpecRequirement, f: GuardFacts): Loss {
  const display = base.status.charAt(0).toUpperCase() + base.status.slice(1).toLowerCase();
  return {
    kind: "REQUIREMENT_REMOVED",
    req_id: base.id,
    file: f.baseReqPath.get(base.id) ?? "",
    line: 0,
    detail: `${base.id} was ${display} at the ref but is absent from the working-tree spec — a requirement is never deleted, and its history is the record`,
  };
}

function implLostLoss(id: string, site: TagSite): Loss {
  return {
    kind: "IMPL_LOST",
    req_id: id,
    file: site.file,
    line: site.line,
    detail: `${id} lost its last implementing @spec tag (was ${site.file}:${site.line})`,
  };
}

function verifyLostLoss(id: string, site: TagSite): Loss {
  return {
    kind: "VERIFY_LOST",
    req_id: id,
    file: site.file,
    line: site.line,
    detail: `${id} lost its last verifying @spec tag (was ${site.file}:${site.line})`,
  };
}

function specFileDeletedLoss(path: string): Loss {
  return {
    kind: "SPEC_FILE_DELETED",
    req_id: null,
    file: path,
    line: 0,
    detail: `canonical spec file ${path} present at the ref is absent from the working tree`,
  };
}

/**
 * A non-Active requirement absent from the working tree is always a loss: the
 * supersede exemption never applies to history, because a superseded entry's
 * successor edge existed before the change and honoring it would make pruning
 * history silent.
 */
function reqDeletedFor(base: SpecRequirement, f: GuardFacts): Loss | null {
  if (f.worktreeReqIds.has(base.id)) return null;
  // @spec GUARD-029
  if (!isActive(base.status)) return historyRemovedLoss(base, f);
  if (isSuperseded(base, f)) return null;
  return reqDeletedLoss(base, f);
}

/** Only a surviving, still-Active requirement is guarded: a deleted one is
 *  REQUIREMENT_REMOVED's, and a superseded one's lost tags are the expected
 *  retag worklist. */
function lastTagGone(id: string, count: number, f: GuardFacts): boolean {
  return f.worktreeActiveIds.has(id) && count === 0;
}

/**
 * Does not sort: format.ts owns the ordering. The tag losses are driven from
 * the code side, not the spec side, so they fire on a code-only change that
 * never touches a SPEC.json.
 */
export function classifyLosses(f: GuardFacts): Loss[] {
  const out: Loss[] = [];

  for (const base of f.baseReqs) {
    const loss = reqDeletedFor(base, f);
    if (loss !== null) out.push(loss);
  }

  for (const [id, site] of f.baseImplSite) {
    if (lastTagGone(id, f.worktreeImplCount.get(id) ?? 0, f)) out.push(implLostLoss(id, site));
  }
  for (const [id, site] of f.baseVerifySite) {
    if (lastTagGone(id, f.worktreeVerifyCount.get(id) ?? 0, f)) out.push(verifyLostLoss(id, site));
  }

  for (const path of f.deletedSpecFiles) out.push(specFileDeletedLoss(path));
  return out;
}
