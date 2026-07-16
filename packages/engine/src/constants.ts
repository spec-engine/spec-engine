// packages/engine/src/constants.ts
//
// Engine-owned filesystem layout, process exit codes, and derived path
// helpers. Before this module the on-disk contract (`.spec-engine/`,
// `spec-engine/`, `SPEC.json`, the two config/manifest filenames) was
// re-spelled as a bare literal at 40+ sites (see the magic-string audit),
// so a rename meant a find-and-replace across every command with real
// drift risk between the code path and the copy-pasted `--out` help text.
// Everything that encodes the layout now derives from here.
//
// Domain VOCABULARY (statuses, severities, tag kinds, query limits) lives in
// @spec-engine/shared next to its type unions — this file owns only the
// engine's filesystem + CLI conventions.

import { rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Output mode shared by every `render*` formatter: human `"text"` or
 * machine `"json"`. Named once here instead of re-spelling the union inline
 * in nine formatter signatures across seven files.
 */
export type RenderMode = "text" | "json";

/** Derived-index directory at the platform root (disposable, gitignored). */
export const INDEX_DIR = ".spec-engine";
/** SQLite index filename inside {@link INDEX_DIR}. */
export const INDEX_DB_FILENAME = "index.sqlite";
/** Canonical specs directory every command discovers and authors into. */
export const CANONICAL_SPECS_DIR = "spec-engine";
/** Sole spec file format (post Phase-18 JSON cutover). */
export const SPEC_FILENAME = "SPEC.json";
/** Per-member opt-in config a sibling repo carries to be indexed. */
export const MEMBER_CONFIG_FILENAME = "spec-engine.member.json";
/** Canonical platform manifest inside {@link CANONICAL_SPECS_DIR}. */
export const PLATFORM_MANIFEST_FILENAME = "spec-engine.platform.json";

/**
 * CLI exit-code convention (documented in AGENTS.md):
 *   0 = success, 1 = gate/check failed on real data, 2 = usage/precondition.
 * Named so the 87-site `process.exit(2)` and the `pass ? 0 : 1` branches
 * read as intent, not folklore.
 */
export const EXIT = { OK: 0, FAILURE: 1, USAGE: 2 } as const;

/** Default derived-index path for a platform: `<dir>/.spec-engine/index.sqlite`. */
export function defaultIndexPath(platformDir: string): string {
  return join(platformDir, INDEX_DIR, INDEX_DB_FILENAME);
}

/**
 * True iff `path` exists and is a directory. Single `statSync` with
 * `throwIfNoEntry:false` — returns `undefined` for a missing path, so there's
 * no existsSync→statSync TOCTOU window (WR-01) and ENOENT yields `false`.
 *
 * Deliberately does NOT catch: EACCES / ELOOP still throw, matching every
 * original site (discover's raw statSync and onboarding's WR-01 form both let
 * non-ENOENT surface so init.ts can honor the INIT-11 exit-2 matrix). A caller
 * that wants to swallow a hard stat failure wraps its own try/catch (see
 * resolve.ts's positional-directory probe).
 */
export function isExistingDir(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * Remove a derived-index DB and its WAL/SHM siblings. The `""` entry deletes
 * the base file; `-wal`/`-shm` are SQLite's write-ahead-log companions that
 * must go too or a cold rebuild reads stale journal pages.
 *
 * NOT the cold-reset front door anymore: the `--fresh` / `--ci` / gate / MCP
 * paths call storage/sqlite.ts `coldResetDb`, which wipes IN PLACE so a live
 * `spec serve` reader never ghosts onto an unlinked inode. This unlink trio
 * remains its fallback (missing or corrupt/unopenable DB file).
 *
 * `force: true` makes each unlink a no-op when the sibling is absent — no
 * throw on a partial trio, and no TOCTOU window between an existence probe
 * and the unlink (the hardened shape gate.ts already used).
 */
export function rmDbTrio(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(dbPath + suffix, { force: true });
  }
}

/**
 * Resolve the effective DB path for a command: `--out` (relative to
 * platformDir, NOT cwd — WR-01) when supplied, else the default index path.
 * Containment is enforced separately by {@link assertContainedPath}; this
 * only resolves.
 */
export function resolveDbPath(platformDir: string, outArg: string | undefined): string {
  return outArg ? resolve(platformDir, outArg) : defaultIndexPath(platformDir);
}

/**
 * Standard `--out` help text, previously copy-pasted verbatim at ~11 command
 * sites (and prone to drifting from the code path it documents).
 */
export const OUT_HELP = `DB path override (default: <platformDir>/${INDEX_DIR}/${INDEX_DB_FILENAME})`;

/**
 * True iff `child` is `parent` itself or lives under it. The load-bearing
 * `sep` suffix on the prefix test stops `/a/bc` from being judged inside
 * `/a/b` (a bare startsWith would accept it). Callers use this for the V12
 * `--out` / `--results` path-containment guard.
 */
export function isContainedPath(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}
