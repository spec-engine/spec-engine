// packages/tracker/src/cache.ts — the deletable, never-hashed resolved-metadata
// sidecar cache (TRK-07).
//
// The cache is "derived but NOT index": it holds resolved issue metadata in a
// plain JSON file at `<platformDir>/.spec-engine/tracker-cache.json` — a sibling of
// `.spec-engine/index.sqlite`, NEVER a table inside it. This module imports no
// SQLite driver, never opens or writes the derived index, and never references
// the build-id hasher. By construction (a non-table file outside the index),
// the sidecar is excluded from the derived index's `build_id`: it is not in the
// hasher's FIXED hashed-table list, so `spec check --ci` and a cold rebuild
// stay byte-identical regardless of tracker reachability or cache contents
// (Pitfall 4).
//
// `.spec-engine/` is gitignored, so the cache is never committed.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TrackerMeta } from "./types";

/** The sidecar filename, written inside `<platformDir>/.spec-engine/`. */
export const SIDECAR_FILE = "tracker-cache.json";

/**
 * One cached entry: the three resolved fields plus the resolve timestamp.
 * Only resolved successes are ever stored — failures are never persisted.
 */
export type CacheEntry = TrackerMeta & { fetched_at: string };

/** The flat sidecar shape: `{ [id]: { title, status, url, fetched_at } }`. */
export type SidecarCache = Record<string, CacheEntry>;

/**
 * 2.3: how long a cached entry is served before it is re-resolved. Issue
 * titles/statuses change rarely, so a day of staleness is an acceptable
 * trade for skipping a network round-trip on every `--resolve-issues` call.
 * The sidecar is never hashed into `build_id`, so this TTL can never perturb
 * cold-rebuild byte-identity.
 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * True when `entry` was fetched within `ttlMs` of `now` (both epoch millis).
 * An unparseable `fetched_at` is treated as stale (re-resolve) rather than
 * trusted forever. This is the read side of `fetched_at` that made the cache
 * actually serve entries instead of being write-only (2.3).
 */
export function isFresh(entry: CacheEntry, now: number, ttlMs: number = CACHE_TTL_MS): boolean {
  const t = Date.parse(entry.fetched_at);
  if (Number.isNaN(t)) return false;
  return now - t < ttlMs;
}

/** Per-entry shape guard — a sidecar hand-edited or written by an older schema
 *  must not feed a malformed entry into the served output (2.3). */
function isValidEntry(e: unknown): e is CacheEntry {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.title === "string" &&
    typeof r.status === "string" &&
    typeof r.url === "string" &&
    typeof r.fetched_at === "string"
  );
}

/**
 * Absolute path to the sidecar for a platform dir:
 * `<platformDir>/.spec-engine/tracker-cache.json`. A sibling of the `.sqlite` index,
 * never a path INTO it.
 */
export function sidecarPath(platformDir: string): string {
  return join(platformDir, ".spec-engine", SIDECAR_FILE);
}

/**
 * Read the sidecar cache. Returns the empty cold-path `{}` if the file is
 * absent OR cannot be parsed as a JSON object, and NEVER throws (TRK-07 /
 * TRK-05 posture). A damaged or deleted cache degrades to the cold path; it
 * never crashes the caller and never touches the derived index.
 */
export async function readCache(platformDir: string): Promise<SidecarCache> {
  try {
    const file = Bun.file(sidecarPath(platformDir));
    if (!(await file.exists())) return {};
    const parsed: unknown = await file.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    // Validate per-entry (2.3): drop anything that is not a well-formed
    // CacheEntry rather than trusting the whole object blindly. A single
    // malformed entry degrades to a cold re-resolve for that id, not a crash.
    const clean: SidecarCache = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidEntry(entry)) clean[id] = entry;
    }
    return clean;
  } catch {
    // Absent, corrupt, or otherwise unreadable → empty cold path, no throw.
    return {};
  }
}

/**
 * Write the sidecar cache, creating `.spec-engine/` if needed. Emits stable,
 * pretty-printed JSON (2-space indent) so diffs and round-trips are
 * deterministic. Operates only on the JSON sidecar — never the `.sqlite` index.
 *
 * Persistence is BEST-EFFORT and NEVER throws (mirrors `readCache`): an
 * unwritable `.spec-engine/` (EACCES), a full disk (ENOSPC), or any other failure
 * degrades silently — the cache is derived/deletable, so a failed write just
 * means the cold path re-resolves next run; it must never crash the caller.
 * Returns `true` if the sidecar was written, `false` if the write failed.
 */
export async function writeCache(platformDir: string, cache: SidecarCache): Promise<boolean> {
  try {
    const path = sidecarPath(platformDir);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, `${JSON.stringify(cache, null, 2)}\n`);
    return true;
  } catch {
    // Cache is derived/deletable — a persist failure must never crash the caller.
    return false;
  }
}

/**
 * Fold no-throw resolve results into a cache, keyed by id. Only `{ok:true}`
 * successes are stored (with a `fetched_at` stamp); failures are skipped so the
 * sidecar holds only resolved metadata. Returns a new object — the input is not
 * mutated.
 */
export function mergeResolved(
  cache: SidecarCache,
  results: Iterable<{ ok: true; id: string; value: TrackerMeta } | { ok: false }>,
  fetchedAt: string = new Date().toISOString(),
): SidecarCache {
  const next: SidecarCache = { ...cache };
  for (const result of results) {
    if (result.ok) {
      next[result.id] = { ...result.value, fetched_at: fetchedAt };
    }
  }
  return next;
}
