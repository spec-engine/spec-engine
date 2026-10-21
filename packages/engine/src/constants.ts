// Engine-owned filesystem layout, process exit codes, and derived path
// helpers. Domain vocabulary (statuses, severities, tag kinds, query limits)
// lives in @spec-engine/shared next to its type unions.

import { rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export type RenderMode = "text" | "json";

/** Disposable and gitignored. */
export const INDEX_DIR = ".spec-engine";
export const INDEX_DB_FILENAME = "index.sqlite";
export const CANONICAL_SPECS_DIR = "spec-engine";
export const SPEC_FILENAME = "SPEC.json";
export const MEMBER_CONFIG_FILENAME = "spec-engine.member.json";
export const PLATFORM_MANIFEST_FILENAME = "spec-engine.platform.json";

/** 0 success, 1 a gate or check failed on real data, 2 usage or precondition (AGENTS.md). */
export const EXIT = { OK: 0, FAILURE: 1, USAGE: 2 } as const;

export function defaultIndexPath(platformDir: string): string {
  return join(platformDir, INDEX_DIR, INDEX_DB_FILENAME);
}

export function specPaths(platformDir: string, key: string): { abs: string; rel: string } {
  return {
    abs: join(platformDir, CANONICAL_SPECS_DIR, key, SPEC_FILENAME),
    rel: `${CANONICAL_SPECS_DIR}/${key}/${SPEC_FILENAME}`,
  };
}

export function memberConfigPath(repoDir: string): string {
  return join(repoDir, MEMBER_CONFIG_FILENAME);
}

/**
 * One `statSync` with `throwIfNoEntry: false`, so there is no exists-then-stat
 * race. EACCES and ELOOP still throw on purpose: `spec init` maps them to exit
 * 2. A caller that wants to swallow them wraps its own try/catch.
 */
export function isExistingDir(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * `-wal` and `-shm` must go with the base file, or a cold rebuild reads stale
 * journal pages. Only the fallback for a missing or unopenable DB: the cold
 * reset itself is storage/sqlite.ts `coldResetDb`, which wipes in place so a
 * live `spec serve` reader never holds an unlinked inode.
 */
export function rmDbTrio(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(dbPath + suffix, { force: true });
  }
}

/** `--out` resolves against platformDir, not cwd. Containment is {@link assertContainedPath}'s job. */
export function resolveDbPath(platformDir: string, outArg: string | undefined): string {
  return outArg ? resolve(platformDir, outArg) : defaultIndexPath(platformDir);
}

export const OUT_HELP = `DB path override (default: <platformDir>/${INDEX_DIR}/${INDEX_DB_FILENAME})`;

/** The `sep` suffix stops `/a/bc` from being judged inside `/a/b`. */
export function isContainedPath(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}
