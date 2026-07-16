// packages/engine/src/guard/collect.ts
//
// GUARD-001/003/004: gather the facts guard/losses.ts decides over. This is the
// ONLY impure module in the guard package — it reads the base ref through the
// one git seam (base/gitBase.ts), the working-tree spec through the shared
// SPEC.json validator, and the working-tree tag counts through the Storage
// interface (the derived index). It writes nothing and returns a plain
// `GuardFacts` bag; the classifier stays pure and git-free.
//
// Cheap by construction (GUARD-01 "keep it cheap"): the base ref is read ONLY
// for the files in the change scope (`git diff --name-status`), never the whole
// tree. The "last tag survives?" question is answered from the already-built
// derived index (Storage) rather than a second full-tree scan.
//
// REUSE, do not re-parse: base requirements go through `validateDomainFile`
// (the ONE structural validator) and base tags through `scanTagsInFile` (the
// ONE tag parser). No second parser is introduced.
//
// D-08 grep-fence: this file imports NO bun:sqlite. Tag counts come through the
// Storage interface, never a raw driver.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type SpecRequirement, type Storage, validateDomainFile } from "@spec-engine/shared";
import { type DiffEntry, gitDiffNameStatus, gitShow } from "../base/gitBase";
import { CANONICAL_SPECS_DIR } from "../constants";
import { DEFAULT_EXTS, findDomainJsonFiles, isPathIgnored } from "../scanner/fs";
import { scanTagsInFile } from "../scanner/tags";
import { scanApprovals } from "./directives";
import type { GuardFacts, TagSite } from "./losses";

const CODE_EXTS: ReadonlySet<string> = new Set(DEFAULT_EXTS);

function isIgnored(path: string): boolean {
  return isPathIgnored(path);
}

/** A canonical spec file: a SPEC.json under the canonical spec dir, outside the ignore list. */
function isSpecFile(path: string): boolean {
  return (
    path.startsWith(`${CANONICAL_SPECS_DIR}/`) && path.endsWith("/SPEC.json") && !isIgnored(path)
  );
}

/** A tag-bearing code file: a DEFAULT_EXTS source file, not a spec file, not
 *  ignored. Restricting to code exts keeps `<!-- @spec -->` doc tags (a
 *  different scanner) from being miscounted as implementations. */
function isCodeFile(path: string): boolean {
  if (isSpecFile(path) || isIgnored(path)) return false;
  const ext = path.includes(".") ? (path.split(".").pop() as string) : "";
  return CODE_EXTS.has(ext);
}

/** Parse SPEC.json bytes → requirements through the ONE validator. A malformed
 *  body contributes zero reqs and never throws — guard is advisory, so a bad
 *  base file must not crash the gate. */
function parseReqs(text: string): SpecRequirement[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const v = validateDomainFile(parsed, "");
  return v.ok ? v.data.requirements : [];
}

/** Base requirements + their source paths, read from the ref for each changed
 *  spec file (an added file has no base blob → gitShow null → skipped). */
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

/** Base implementing/verifying tag sites (first site per id wins, so the block
 *  message points at a stable location) read from the ref for each changed code
 *  file. Kind is path-derived by the shared scanner. */
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

/** Working-tree requirement facts: every id, the Active subset, and the set of
 *  ids some surviving req supersedes (the GUARD-006 backward-supersede path). */
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

/** Tally implementing/verifying tag counts across the WHOLE working tree from
 *  the derived index (Storage seam). This is the "does the last tag survive?"
 *  oracle — full-tree, but free (the index is already built). */
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

/** Requirement ids acknowledged by an `@spec approve` directive anywhere in the
 *  still-present changed files (a deleted file carries no worktree text). */
async function collectApprovals(
  platformDir: string,
  changed: readonly DiffEntry[],
): Promise<Set<string>> {
  const approved = new Set<string>();
  for (const entry of changed) {
    if (entry.status === "D") continue;
    const abs = join(platformDir, entry.path);
    if (!existsSync(abs)) continue;
    const text = await Bun.file(abs).text();
    for (const a of scanApprovals(text)) approved.add(a.req_id);
  }
  return approved;
}

/**
 * Assemble the full `GuardFacts` bag for the classifier. Orchestrates the five
 * collectors above over the `git diff --name-status <ref>` change scope; each
 * collector stays small and single-purpose so no function exceeds the biome
 * complexity ceiling.
 */
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
  const approved = await collectApprovals(platformDir, changed);

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
    approved,
    deletedSpecFiles,
  };
}
