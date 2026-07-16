// packages/engine/src/onboarding/context.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INIT-009
//
// INIT-07 / INIT-15: substrate for "where am I?" detection used by
// commands/init.ts (Plan 09-02) and Phase 10's interactive prompt.
//
// Behaviors:
//   - detectContext(dir): returns { kind, platformDir, platformVersion }
//     where kind is "platform" | "member" | "loose".
//   - findPlatformDirUpward(startDir): walks upward with three termination
//     rules in this exact order: (a) current dir has spec-engine/ child as
//     directory → return current; (b) current dir has .git/ child → return
//     null; (c) parent(current) === current → return null.
//
// See RESEARCH § Pattern 2 (upward walk + termination guarantees).
// RED-85: the platform version is DERIVED (max domain version) via
// `derivePlatformVersion`; the authored spec-engine.platform.json manifest is
// retired, so the old malformed-manifest throw path is gone — a malformed
// SPEC.json surfaces loudly at parse/check time instead.
//
// HARD CONSTRAINT (D-08): this file does NOT import bun:sqlite directly.

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isExistingDir } from "../constants";
import { derivePlatformVersion } from "../indexer/discover";

/**
 * Walks upward from `startDir` looking for a platform root (a directory
 * with a `spec-engine/` subdirectory). Termination order is the contract
 * — do NOT rearrange:
 *   (a) `<current>/spec-engine` exists AND isDirectory → return current
 *   (b) `<current>/.git` exists (any fs entry type) → return null (repo boundary)
 *   (c) `dirname(current) === current` → return null (fs root)
 *
 * The (a) check sits first so that "current dir IS the platform" wins
 * over "current dir IS a .git repo root."
 *
 * WR-01: Both checks use `statSync(p, { throwIfNoEntry: false })` to
 * eliminate the existsSync+statSync TOCTOU window and to swallow
 * ENOENT for broken symlinks. EACCES / ELOOP still surface as throws;
 * callers (init.ts) wrap detectContext in try/catch + exit 2 to honor
 * the INIT-11 exit-code matrix.
 *
 * WR-03: branches (a) and (b) deliberately differ. (a) requires
 * isDirectory() because a `spec-engine` file would not be a platform
 * root; (b) accepts any fs entry because submodules and worktrees
 * legitimately have `.git` as a file pointer rather than a directory.
 */
export function findPlatformDirUpward(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    const specsCandidate = join(current, "spec-engine");
    if (isExistingDir(specsCandidate)) {
      return current;
    }
    const gitCandidate = join(current, ".git");
    // WR-03: .git can legitimately be a file (submodule / worktree pointer)
    // OR a directory (normal repo). Both are repo-boundary markers — so we
    // accept any fs entry here, unlike the isDirectory()-strict (a) check.
    if (statSync(gitCandidate, { throwIfNoEntry: false }) !== undefined) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Answers the "where am I?" question for `dir`. Branch order is the contract:
 *   (1) platform: `dir` has a `spec-engine/` child as a directory.
 *   (2) member: `dir` has a `spec-engine.member.json` file child.
 *   (3) loose:    neither marker is present.
 *
 * For member and loose, walks upward via `findPlatformDirUpward(dir)` to
 * locate the enclosing platform (Open Question 3 resolution: loose ALSO
 * walks — only kind="platform" skips because it IS the platform). When a
 * platform is found, `platformVersion` is DERIVED from its domain SPEC.json
 * files via `derivePlatformVersion` (max domain version, default 1);
 * otherwise both platformDir and platformVersion are null.
 */
export async function detectContext(dir: string): Promise<{
  kind: "platform" | "member" | "loose";
  platformDir: string | null;
  platformVersion: number | null;
}> {
  const absDir = resolve(dir);

  // (1) Platform: dir has a spec-engine/ child as a directory.
  // WR-01: statSync({throwIfNoEntry:false}) eliminates the existsSync+statSync
  // TOCTOU window and swallows ENOENT cleanly (broken symlink → undefined,
  // not a throw). Other stat errors (EACCES/ELOOP) still propagate to the
  // try/catch around detectContext in commands/init.ts:84 → exit 2.
  const specsCandidate = join(absDir, "spec-engine");
  if (statSync(specsCandidate, { throwIfNoEntry: false })?.isDirectory()) {
    const platformVersion = await derivePlatformVersion(absDir);
    return { kind: "platform", platformDir: absDir, platformVersion };
  }

  // (2) Member: dir has a spec-engine.member.json file child.
  const configCandidate = join(absDir, "spec-engine.member.json");
  if (statSync(configCandidate, { throwIfNoEntry: false }) !== undefined) {
    const platformDir = findPlatformDirUpward(absDir);
    if (platformDir === null) {
      return { kind: "member", platformDir: null, platformVersion: null };
    }
    const platformVersion = await derivePlatformVersion(platformDir);
    return { kind: "member", platformDir, platformVersion };
  }

  // (3) Loose: neither marker present — also walks upward (Open Q3).
  const platformDir = findPlatformDirUpward(absDir);
  if (platformDir === null) {
    return { kind: "loose", platformDir: null, platformVersion: null };
  }
  const platformVersion = await derivePlatformVersion(platformDir);
  return { kind: "loose", platformDir, platformVersion };
}
