// packages/engine/src/storage/errors.ts
//
// Classifier for OPERATIONAL SQLite failures — the "environment broke the
// database" family (locks denied, contention, corruption, disk full), as
// opposed to programming errors in our own SQL, which must stay loud 500s /
// raw throws so they get fixed rather than retried.
//
// Motivation (webapp hardening follow-up): a sandboxed agent process (e.g.
// Claude Code's default seatbelt profile on macOS) cannot take the file locks
// WAL-mode SQLite needs, so every query throws SQLITE_IOERR_VNODE. Before
// this seam existed the failure surfaced as a raw stack trace from a 500 —
// or worse, as the webapp's downstream "SyntaxError: Failed to parse JSON" —
// and nothing pointed at the sandbox. Agents act on stderr and error bodies;
// a named cause with a fix gets self-corrected in one turn.
//
// This module deliberately does NOT import bun:sqlite (D-08 — storage/
// sqlite.ts is the only importer). SQLiteError is detected structurally via
// its `code` string, which also keeps the classifier usable on errors that
// crossed a serialization boundary.

/** A classified operational storage failure: the SQLite result code plus an
 *  actionable, user/agent-facing hint. */
export interface StorageErrorInfo {
  code: string;
  hint: string;
}

const LOCK_HINT =
  "SQLite could not open or lock the index database. This usually means the " +
  "process is running inside a sandbox that denies file locks (common for " +
  "coding-agent sandboxes — re-run the command unsandboxed) or lacks " +
  "permission to the .spec-engine/ directory.";

const BUSY_HINT =
  "the index database is locked by another spec process (a concurrent " +
  "`spec check`, `spec gate`, or `spec serve`). Retry once it finishes.";

const CORRUPT_HINT =
  "the index database is unreadable. It is a disposable derived cache — " +
  "delete .spec-engine/index.sqlite (plus its -wal/-shm siblings) and re-run " +
  "to rebuild it from the spec files.";

const FULL_HINT = "the disk holding the .spec-engine/ index directory is full.";

/**
 * Map an unknown thrown value to a {@link StorageErrorInfo} when it is an
 * OPERATIONAL SQLite failure, or `null` when it is not (not SQLite at all,
 * or a SQLite code like plain SQLITE_ERROR that indicates a bug in our SQL
 * and must keep propagating unchanged).
 *
 * Families and their hints:
 *   - SQLITE_IOERR* / SQLITE_CANTOPEN* / SQLITE_PERM / SQLITE_READONLY* /
 *     SQLITE_AUTH → lock/permission problem, most often a sandbox (LOCK_HINT)
 *   - SQLITE_BUSY* / SQLITE_LOCKED* → cross-process contention (BUSY_HINT)
 *   - SQLITE_CORRUPT* / SQLITE_NOTADB → rebuildable cache damage (CORRUPT_HINT)
 *   - SQLITE_FULL → disk full (FULL_HINT)
 */
export function describeStorageError(err: unknown): StorageErrorInfo | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || !code.startsWith("SQLITE_")) return null;
  if (
    code.startsWith("SQLITE_IOERR") ||
    code.startsWith("SQLITE_CANTOPEN") ||
    code.startsWith("SQLITE_READONLY") ||
    code === "SQLITE_PERM" ||
    code === "SQLITE_AUTH"
  ) {
    return { code, hint: LOCK_HINT };
  }
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
    return { code, hint: BUSY_HINT };
  }
  if (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB") {
    return { code, hint: CORRUPT_HINT };
  }
  if (code === "SQLITE_FULL") {
    return { code, hint: FULL_HINT };
  }
  return null;
}

/**
 * One-line stderr rendering for the CLI layer: names the database path, the
 * SQLite code, and the actionable hint. Callers print this and exit
 * EXIT.FAILURE (see commands/_shared.ts handleStorageUnavailable).
 */
export function formatStorageUnavailable(info: StorageErrorInfo, dbPath: string): string {
  return `spec: cannot access the index database at ${dbPath} (${info.code}) — ${info.hint}`;
}
