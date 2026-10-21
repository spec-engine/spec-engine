// Only operational failures (locks denied, contention, corruption, disk full)
// are classified. A bug in our own SQL must stay a loud raw throw so it gets
// fixed rather than retried. A sandboxed agent cannot take the file locks WAL
// mode needs, so every query throws SQLITE_IOERR_VNODE; naming that cause is
// what lets the agent fix it in one turn.
//
// SQLiteError is detected structurally by its `code` string, not imported:
// storage/sqlite.ts is the only bun:sqlite importer, and a structural check
// also works on errors that crossed a serialization boundary.

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

/** `null` for plain SQLITE_ERROR: that is a bug in our SQL and must keep
 *  propagating unchanged. */
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

export function formatStorageUnavailable(info: StorageErrorInfo, dbPath: string): string {
  return `spec: cannot access the index database at ${dbPath} (${info.code}) — ${info.hint}`;
}
