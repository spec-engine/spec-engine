// packages/engine/src/commands/_shared.ts
//
// The CLI adapters over the operations layer's index helper: print what an
// operation returns as warnings, and map the errors it lets propagate onto
// the exit-code contract. Nothing below decides behavior.

import type { Storage } from "@spec-engine/shared";
import { NotASpecPlatformError } from "@spec-engine/shared";
import { EXIT, isContainedPath } from "../constants";
import { formatNotASpecPlatform } from "../indexer/discover";
import { withIndex } from "../operations/_index";
import type { OpFailure, OpWarning } from "../operations/_result";
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
}

/**
 * The read-command scaffold: open the index (building it when missing, or
 * cold when `fresh`), print the staleness notice, run `fn`, close. A
 * non-platform directory exits 2 with the friendly message; a sandboxed or
 * locked database exits 1 with its hint.
 */
export async function withReadStorage(
  opts: ReadStorageOptions,
  fn: (storage: Storage) => void | Promise<void>,
): Promise<void> {
  const { platformDir, dbPath, fresh } = opts;
  try {
    await withIndex({ platformDir, dbPath, build: fresh ? "fresh" : "missing" }, async (h) => {
      for (const w of h.warnings) console.error(w);
      await fn(h.storage);
    });
  } catch (e) {
    handleStorageUnavailable(e, dbPath);
    handleNotAPlatform(e);
  }
}
