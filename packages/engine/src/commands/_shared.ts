// packages/engine/src/commands/_shared.ts
//
// Leaf helpers shared by the command layer. Each was previously copy-pasted
// across ~10-15 subcommands (see the DRY audit) — every `query.ts` etc. that
// says "mirrors commands/map.ts / propagation.ts / check.ts" collapses onto
// these. Extracting them also centralizes two invariants that were
// correct-by-copy-paste and at risk of silent drift: the V12 path-containment
// guard and the cold-reset primitive.

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { NotASpecPlatformError, type Storage, type Tag } from "@spec-engine/shared";
import { defaultIndexPath, EXIT, isContainedPath } from "../constants";
import { assertSpecPlatform, formatNotASpecPlatform } from "../indexer/discover";
import { runIndex } from "../indexer/pipeline";
import { describeStorageError, formatStorageUnavailable } from "../storage/errors";
import { coldResetDb, openStorage } from "../storage/sqlite";

// coldResetDb is the "never trust a warm index" primitive shared by the
// command layer AND server/mcp.ts — an IN-PLACE wipe (inode-preserving, so a
// live `spec serve` reader never ghosts onto an unlinked file) that lives in
// ../storage/sqlite per D-08. Re-exported here so command files pick it up
// alongside the CLI-exiting helpers below.
export { coldResetDb } from "../storage/sqlite";

/**
 * V12 path-containment guard: a user-supplied `--out` / `--results` path must
 * resolve to somewhere inside `platformDir`, so a hostile or accidental
 * `--out ../../x.sqlite` cannot write outside the platform tree. On violation,
 * prints the command-specific `subject` and exits 2.
 *
 * `subject` is the message prefix through the flag name, e.g.
 * `"spec query: --out"` → `"spec query: --out path must be inside platformDir …"`.
 */
export function assertContainedPath(resolved: string, platformDir: string, subject: string): void {
  if (!isContainedPath(resolved, platformDir)) {
    console.error(`${subject} path must be inside platformDir (resolved to ${resolved})`);
    process.exit(EXIT.USAGE);
  }
}

/**
 * Standard read-command handling for a caught `NotASpecPlatformError`: emit
 * the friendly, actionable message and exit 2 (usage-style) rather than
 * letting the raw stack trace escape. Any other error is rethrown unchanged,
 * so callers with richer catch logic (e.g. index.ts's FAILED→exit-1 branch)
 * should NOT route through this helper. Returns `never`.
 */
export function handleNotAPlatform(e: unknown): never {
  if (e instanceof NotASpecPlatformError) {
    console.error(formatNotASpecPlatform(e.platformDir));
    process.exit(EXIT.USAGE);
  }
  throw e;
}

/**
 * Standard handling for a caught OPERATIONAL SQLite failure (storage/errors.ts
 * classifier): emit the actionable one-liner — which names the sandbox
 * file-lock cause, contention, or cache corruption — and exit 1. A
 * non-storage error falls through (returns void) so the caller can continue
 * to its other handlers (e.g. handleNotAPlatform). Runs BEFORE any generic
 * "failed" wrapper so agents get a named cause instead of a raw SQLiteError
 * stack.
 */
export function handleStorageUnavailable(e: unknown, dbPath: string): void {
  const info = describeStorageError(e);
  if (info === null) return;
  console.error(formatStorageUnavailable(info, dbPath));
  process.exit(EXIT.FAILURE);
}

/**
 * The read-command storage scaffold, shared by map / query / propagation /
 * relations / provenance / resolve. Owns the whole lifecycle so each command
 * body shrinks to "resolve args → render":
 *
 *   1. assertSpecPlatform pre-flight BEFORE any FS write — a non-platform dir
 *      throws → friendly message → exit 2, leaving NO .spec-engine/ artifact
 *      (CLAUDE.md: the derived DB owns nothing; a failed build leaves nothing).
 *   2. mkdir the index dir; `fresh` opts into the cold path (in-place reset).
 *   3. Open, then transparently re-index when the DB was missing OR holds zero
 *      repos. RED-16 / D-12: an indexed platform always has ≥1 repo row (the
 *      canonical), so an empty repos table unambiguously means "no index here"
 *      — this covers the silent-rebuild case where openStorage wiped a DB whose
 *      _schema_version predated a SCHEMA_VERSION bump. Without the second
 *      disjunct, read commands emit empty output (exit 0) until a manual
 *      `spec index`.
 *   4. Run `fn` with the open storage, then close it in a `finally` (Bun's
 *      process.exit skips finally, so a callback that exits mid-read is
 *      responsible for its own close — matching the prior per-command code).
 *
 * A `NotASpecPlatformError` from step 1 (or anywhere in `fn`) is routed to
 * {@link handleNotAPlatform}: friendly exit 2 for not-a-platform, rethrow
 * otherwise.
 */
/** Inputs to {@link withReadStorage}: where the platform + its index live, and
 *  whether to force a cold rebuild first. */
export interface ReadStorageOptions {
  platformDir: string;
  dbPath: string;
  fresh?: boolean;
}

/**
 * Cold-reindex the platform and return every tag site bound to one requirement
 * id. The "never trust a warm index" cousin of {@link withReadStorage} for the
 * LIFECYCLE commands (supersede / amend): canonical truth is about to change or
 * be gated on, so the answer must reflect the current tree — a cold reset +
 * fresh `runIndex` before the single `listTags` query. D-08: index access goes
 * through openStorage, never a direct bun:sqlite import.
 */
export async function reindexAndListTags(platformDir: string, reqId: string): Promise<Tag[]> {
  const dbPath = defaultIndexPath(platformDir);
  coldResetDb(dbPath);
  const storage = openStorage(dbPath);
  try {
    await runIndex({ platformDir, storage });
    return storage.listTags({ req_id: reqId });
  } finally {
    storage.close();
  }
}

export async function withReadStorage(
  opts: ReadStorageOptions,
  fn: (storage: Storage) => void | Promise<void>,
): Promise<void> {
  const { platformDir, dbPath, fresh } = opts;
  try {
    assertSpecPlatform(platformDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    if (fresh) coldResetDb(dbPath);
    const needsIndex = !existsSync(dbPath);
    const storage = openStorage(dbPath);
    try {
      if (needsIndex || storage.listRepos().length === 0) {
        await runIndex({ platformDir, storage });
      }
      await fn(storage);
    } finally {
      storage.close();
    }
  } catch (e) {
    // Operational storage failure (sandboxed locks / contention / corrupt
    // cache) → actionable message + exit 1; falls through when not one.
    handleStorageUnavailable(e, dbPath);
    handleNotAPlatform(e);
  }
}
