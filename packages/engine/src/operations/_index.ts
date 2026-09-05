// packages/engine/src/operations/_index.ts
//
// The one place an operation or a surface acquires a Storage handle over the
// derived index. Four build policies:
//   fresh   — cold-reset the DB in place, open, run the index (never trust a
//             warm index: every MCP call, `gate`, the lifecycle commands, and
//             `--fresh` reads).
//   reset   — cold-reset and open without building; the operation runs the
//             index itself because it needs the IndexResult (`check --ci`).
//   missing — open; build only when the DB is absent or holds zero repos (the
//             warm read path of map / query / resolve / propagation).
//   never   — open without building (the caller will run the index itself).
//
// `assertSpecPlatform` runs before any filesystem write, so a non-platform
// directory throws NotASpecPlatformError and leaves no `.spec-engine/` behind.
// Errors propagate: the surface maps them (the CLI to exit codes, the API to
// a 503, MCP to isError). Nothing here prints.

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { CANONICAL_SPECS_DIR, defaultIndexPath, SPEC_FILENAME } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { runIndex } from "../indexer/pipeline";
import { coldResetDb, openStorage } from "../storage/sqlite";

export type IndexBuild = "fresh" | "reset" | "missing" | "never";

export interface WithIndexOptions {
  platformDir: string;
  /** Defaults to `<platformDir>/.spec-engine/index.sqlite`. */
  dbPath?: string;
  build: IndexBuild;
}

export interface IndexHandle {
  storage: Storage;
  /** Stderr-worthy notices the surface may print: today, only the warm-index staleness warning. */
  warnings: string[];
  /** True when this call ran the index (so `build_id` and diagnostics are current). */
  built: boolean;
}

/**
 * Open the index under `opts.build`, run `fn`, and close the handle in a
 * `finally`. A callback that calls `process.exit` skips the close (Bun exits
 * synchronously), which matches every command that did so before this helper.
 */
export async function withIndex<T>(
  opts: WithIndexOptions,
  fn: (handle: IndexHandle) => T | Promise<T>,
): Promise<T> {
  const { platformDir, build } = opts;
  const dbPath = opts.dbPath ?? defaultIndexPath(platformDir);
  assertSpecPlatform(platformDir);
  mkdirSync(dirname(dbPath), { recursive: true });
  if (build === "fresh" || build === "reset") coldResetDb(dbPath);
  const wasMissing = !existsSync(dbPath);
  const storage = openStorage(dbPath);
  try {
    const warnings: string[] = [];
    let built = false;
    if (
      build === "fresh" ||
      (build === "missing" && (wasMissing || storage.listRepos().length === 0))
    ) {
      await runIndex({ platformDir, storage });
      built = true;
    } else if (build === "missing") {
      const stale = staleIndexWarning(platformDir, dbPath);
      if (stale !== null) warnings.push(stale);
    }
    return await fn({ storage, warnings, built });
  } finally {
    storage.close();
  }
}

/**
 * The warm-index staleness notice: a canonical spec file newer than the DB.
 * Only the canonical SPEC.json mtimes are compared (walking every member's
 * code would cost more than the reindex), so a tag-only edit goes undetected.
 * Never throws; a stat failure just means no warning.
 */
// @spec INDX-006
function staleIndexWarning(platformDir: string, dbPath: string): string | null {
  try {
    const dbMtime = statSync(dbPath).mtimeMs;
    const specsDir = join(platformDir, CANONICAL_SPECS_DIR);
    for (const entry of readdirSync(specsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const specPath = join(specsDir, entry.name, SPEC_FILENAME);
      if (!existsSync(specPath)) continue;
      if (statSync(specPath).mtimeMs > dbMtime) {
        return `spec: warning — ${CANONICAL_SPECS_DIR}/${entry.name}/${SPEC_FILENAME} changed after the index was built; results may be stale. Pass --fresh to rebuild.`;
      }
    }
  } catch {
    // Staleness detection must never break a read.
  }
  return null;
}
