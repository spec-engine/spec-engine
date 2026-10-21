// The only impure module in the guard package; losses.ts stays pure and
// git-free. The base ref is read only for the files in the change scope, never
// the whole tree, and "does the last tag survive?" is answered from the
// already-built index rather than a second full-tree scan.

import { join } from "node:path";
import { parseDomainText, type SpecRequirement, type Storage } from "@spec-engine/shared";
import { gitDiffNameStatus, gitShow } from "../base/gitBase";
import { CANONICAL_SPECS_DIR } from "../constants";
import { findDomainJsonFiles, isPathIgnored, isTagSource } from "../scanner/fs";
import { scanTagsInFile } from "../scanner/tags";
import type { GuardFacts, TagSite } from "./losses";

function isIgnored(path: string): boolean {
  return isPathIgnored(path);
}

/** A canonical spec file: a SPEC.json under the canonical spec dir, outside the ignore list. */
function isSpecFile(path: string): boolean {
  return (
    path.startsWith(`${CANONICAL_SPECS_DIR}/`) && path.endsWith("/SPEC.json") && !isIgnored(path)
  );
}

/** Doc files carry `<!-- @spec -->` tags for a different scanner; only tag-source files count as implementations. */
function isCodeFile(path: string): boolean {
  return !isSpecFile(path) && !isIgnored(path) && isTagSource(path);
}

/** A malformed body contributes zero reqs and never throws: a bad base file
 *  must not crash the gate. */
function parseReqs(text: string): SpecRequirement[] {
  const v = parseDomainText(text, "");
  return v.ok ? v.data.requirements : [];
}

/** An added file has no base blob, so gitShow returns null and it is skipped. */
function collectBaseReqs(
  platformDir: string,
  ref: string,
  specPaths: readonly string[],
): { reqs: SpecRequirement[]; path: Map<string, string> } {
  const reqs: SpecRequirement[] = [];
  const path = new Map<string, string>();
  for (const p of specPaths) {
    const bytes = gitShow(platformDir, ref, p);
    if (bytes === null) continue;
    for (const r of parseReqs(bytes)) {
      reqs.push(r);
      path.set(r.id, p);
    }
  }
  return { reqs, path };
}

/** The first site per id wins, so the block message points at a stable location. */
function collectBaseTags(
  platformDir: string,
  ref: string,
  codePaths: readonly string[],
): { implSite: Map<string, TagSite>; verifySite: Map<string, TagSite> } {
  const implSite = new Map<string, TagSite>();
  const verifySite = new Map<string, TagSite>();
  for (const p of codePaths) {
    const bytes = gitShow(platformDir, ref, p);
    if (bytes === null) continue;
    for (const tag of scanTagsInFile("", p, bytes)) {
      const target = tag.kind === "verifies" ? verifySite : implSite;
      if (!target.has(tag.req_id)) target.set(tag.req_id, { file: tag.file, line: tag.line });
    }
  }
  return { implSite, verifySite };
}

/** `supersedesTargets` feeds the backward-supersede suppression: a surviving
 *  req that names a removed one as its predecessor ends it. */
async function collectWorktreeReqs(canonicalDir: string): Promise<{
  ids: Set<string>;
  activeIds: Set<string>;
  supersedesTargets: Set<string>;
}> {
  const ids = new Set<string>();
  const activeIds = new Set<string>();
  const supersedesTargets = new Set<string>();
  for (const rel of await findDomainJsonFiles(canonicalDir)) {
    const text = await Bun.file(join(canonicalDir, rel)).text();
    for (const r of parseReqs(text)) {
      ids.add(r.id);
      if (r.status.toLowerCase() === "active") activeIds.add(r.id);
      if (r.supersedes != null) supersedesTargets.add(r.supersedes);
    }
  }
  return { ids, activeIds, supersedesTargets };
}

function tallyWorktreeTags(storage: Storage): {
  implCount: Map<string, number>;
  verifyCount: Map<string, number>;
} {
  const implCount = new Map<string, number>();
  const verifyCount = new Map<string, number>();
  for (const t of storage.listTags()) {
    const bucket = t.kind === "implements" ? implCount : t.kind === "verifies" ? verifyCount : null;
    if (bucket !== null) bucket.set(t.req_id, (bucket.get(t.req_id) ?? 0) + 1);
  }
  return { implCount, verifyCount };
}

export async function collectFacts(
  platformDir: string,
  ref: string,
  storage: Storage,
): Promise<GuardFacts> {
  const changed = gitDiffNameStatus(platformDir, ref);
  const specPaths = changed.filter((e) => isSpecFile(e.path)).map((e) => e.path);
  const codePaths = changed.filter((e) => isCodeFile(e.path)).map((e) => e.path);
  const deletedSpecFiles = changed
    .filter((e) => e.status === "D" && isSpecFile(e.path))
    .map((e) => e.path);

  const base = collectBaseReqs(platformDir, ref, specPaths);
  const baseTags = collectBaseTags(platformDir, ref, codePaths);
  const worktree = await collectWorktreeReqs(join(platformDir, CANONICAL_SPECS_DIR));
  const counts = tallyWorktreeTags(storage);

  return {
    baseReqs: base.reqs,
    baseReqPath: base.path,
    baseImplSite: baseTags.implSite,
    baseVerifySite: baseTags.verifySite,
    worktreeReqIds: worktree.ids,
    worktreeActiveIds: worktree.activeIds,
    worktreeSupersedesTargets: worktree.supersedesTargets,
    worktreeImplCount: counts.implCount,
    worktreeVerifyCount: counts.verifyCount,
    deletedSpecFiles,
  };
}
