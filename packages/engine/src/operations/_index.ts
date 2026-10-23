// Build policies:
//   fresh   — cold-reset, open, run the index (never trusts a warm index).
//   reset   — cold-reset and open without building; the caller runs the index
//             because it needs the IndexResult (`check --ci`).
//   missing — open; build only when the DB is absent or holds zero repos.
//   never   — open without building.
// `assertSpecPlatform` must run before any filesystem write, so a
// non-platform directory leaves no `.spec-engine/` behind.

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Storage, Tag } from "@spec-engine/shared";
import { type PossibleDuplicate, scanDuplicates } from "../check/duplicates";
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

/** A callback that calls `process.exit` skips the close: Bun exits synchronously. */
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

/** Every tag site for one requirement, from an index that reflects the current tree. */
export type FreshTags = (reqId: string) => Promise<Tag[]>;

/**
 * The fresh-tags provider a one-shot surface (the CLI, an MCP call) hands to a
 * lifecycle operation: cold-rebuild the index, answer, close. A long-lived
 * surface (the HTTP API) supplies its own over the handle it keeps.
 */
export function coldFreshTags(platformDir: string): FreshTags {
  return (reqId) =>
    withIndex({ platformDir, build: "fresh" }, (h) => h.storage.listTags({ req_id: reqId }));
}

/** The possible duplicates of a statement just written, minus the ids `exclude` names. */
export type DuplicateScan = (statement: string, exclude: string[]) => Promise<PossibleDuplicate[]>;

/**
 * The scan a one-shot surface hands to an authoring operation. `fresh`
 * cold-rebuilds the index first; `never` reads the index a preceding
 * `coldFreshTags` call already rebuilt. The scan only advises, so a refused
 * build or an unavailable database yields no candidates instead of failing
 * a write that already landed.
 */
export function coldDuplicateScan(
  platformDir: string,
  build: "fresh" | "never" = "fresh",
): DuplicateScan {
  return async (statement, exclude) => {
    try {
      return await withIndex({ platformDir, build }, (h) =>
        scanDuplicates(h.storage, platformDir, statement, exclude),
      );
    } catch {
      return [];
    }
  };
}
