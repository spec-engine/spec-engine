import type { Storage } from "@spec-engine/shared";
import { InvalidDomainFilesError, NotASpecPlatformError } from "@spec-engine/shared";
import { renderDiagnostics } from "../check/format";
import { EXIT, isContainedPath } from "../constants";
import { formatNotASpecPlatform } from "../indexer/discover";
import { coldFreshTags, type FreshTags, withIndex } from "../operations/_index";
import type { OpFailure, OpWarning } from "../operations/_result";
import { exit } from "../stdout";
import { describeStorageError, formatStorageUnavailable } from "../storage/errors";

export { coldResetDb } from "../storage/sqlite";

/**
 * A user-supplied `--out` / `--results` path must resolve inside
 * `platformDir`; otherwise print `subject` and exit 2.
 */
export function assertContainedPath(resolved: string, platformDir: string, subject: string): void {
  if (!isContainedPath(resolved, platformDir)) {
    console.error(`${subject} path must be inside platformDir (resolved to ${resolved})`);
    process.exit(EXIT.USAGE);
  }
}

/** A caught `NotASpecPlatformError` becomes the friendly message and exit 2; anything else rethrows. */
export function handleNotAPlatform(e: unknown): never {
  if (e instanceof NotASpecPlatformError) {
    console.error(formatNotASpecPlatform(e.platformDir));
    process.exit(EXIT.USAGE);
  }
  throw e;
}

/**
 * A refused index build prints its INVALID_DOMAIN_FILE rows and nothing else
 * (the `check --json` rows on stdout under `json`, text rows on stderr
 * otherwise) and exits `code`; anything else falls through.
 * @spec INDX-017
 */
export async function handleInvalidDomainFiles(
  e: unknown,
  json: boolean,
  code: number = EXIT.FAILURE,
): Promise<void> {
  if (!(e instanceof InvalidDomainFilesError)) return;
  if (json) console.log(renderDiagnostics(e.diagnostics, "json"));
  else console.error(renderDiagnostics(e.diagnostics, "text"));
  await exit(code);
}

/** `coldFreshTags` for a lifecycle command, whose exits are 0 or 2: a refused build exits 2. */
export function cliFreshTags(platformDir: string): FreshTags {
  const fresh = coldFreshTags(platformDir);
  return async (reqId) => {
    try {
      return await fresh(reqId);
    } catch (e) {
      await handleInvalidDomainFiles(e, false, EXIT.USAGE);
      throw e;
    }
  };
}

/** An operational SQLite failure becomes its actionable one-liner and exit 1; anything else falls through. */
export function handleStorageUnavailable(e: unknown, dbPath: string): void {
  const info = describeStorageError(e);
  if (info === null) return;
  console.error(formatStorageUnavailable(info, dbPath));
  process.exit(EXIT.FAILURE);
}

/** Print an operation's warnings to stderr with the prefix each kind has always carried. */
export function printWarnings(cmdName: string, warnings: OpWarning[] | undefined): void {
  for (const w of warnings ?? []) {
    if (w.kind === "ref") console.error(`spec req: warning — ${w.text}`);
    else if (w.kind === "grammar") console.error(`${cmdName}: ${w.text}`);
    else console.error(w.text);
  }
}

/** Print an operation's refusal (its warnings, then its detail or diagnostics) and exit 2. */
export function exitOnFailure(cmdName: string, failure: OpFailure): never {
  printWarnings(cmdName, failure.warnings);
  if (failure.diagnostics && failure.diagnostics.length > 0) {
    for (const diag of failure.diagnostics) console.error(`${cmdName}: ${diag.detail}`);
  } else {
    console.error(`${cmdName}: ${failure.detail}`);
  }
  process.exit(EXIT.USAGE);
}

export interface ReadStorageOptions {
  platformDir: string;
  dbPath: string;
  fresh?: boolean;
  json?: boolean;
}

/**
 * The read-command scaffold: open the index (building it when missing, or
 * cold when `fresh`), print the staleness notice, run `fn`, close. A
 * non-platform directory exits 2 with the friendly message; a sandboxed or
 * locked database or a refused build exits 1.
 */
export async function withReadStorage(
  opts: ReadStorageOptions,
  fn: (storage: Storage) => void | Promise<void>,
): Promise<void> {
  const { platformDir, dbPath, fresh, json = false } = opts;
  try {
    await withIndex({ platformDir, dbPath, build: fresh ? "fresh" : "missing" }, async (h) => {
      for (const w of h.warnings) console.error(w);
      await fn(h.storage);
    });
  } catch (e) {
    handleStorageUnavailable(e, dbPath);
    await handleInvalidDomainFiles(e, json);
    handleNotAPlatform(e);
  }
}
