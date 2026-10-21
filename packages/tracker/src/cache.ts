// A plain JSON file beside the derived index, never a table in it: it stays
// out of `build_id`, so `spec check --ci` and a cold rebuild are byte-identical
// whatever the tracker returned. This module must not import a SQLite driver.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TrackerMeta } from "./types";

export const SIDECAR_FILE = "tracker-cache.json";

/** Only successes are stored; failures are never persisted. */
export type CacheEntry = TrackerMeta & { fetched_at: string };

export type SidecarCache = Record<string, CacheEntry>;

/** A day: titles and statuses change rarely, and a skipped round-trip is worth the staleness. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** An unparseable `fetched_at` is stale, never trusted forever. */
export function isFresh(entry: CacheEntry, now: number, ttlMs: number = CACHE_TTL_MS): boolean {
  const t = Date.parse(entry.fetched_at);
  if (Number.isNaN(t)) return false;
  return now - t < ttlMs;
}

/** A hand-edited or older-schema entry must not reach the served output. */
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

export function sidecarPath(platformDir: string): string {
  return join(platformDir, ".spec-engine", SIDECAR_FILE);
}

/** Never throws: an absent, corrupt, or malformed cache degrades to a cold re-resolve. */
export async function readCache(platformDir: string): Promise<SidecarCache> {
  try {
    const file = Bun.file(sidecarPath(platformDir));
    if (!(await file.exists())) return {};
    const parsed: unknown = await file.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const clean: SidecarCache = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidEntry(entry)) clean[id] = entry;
    }
    return clean;
  } catch {
    return {};
  }
}

/**
 * Best-effort and never throws: the cache is deletable, so a failed write
 * (EACCES, ENOSPC) only means the next run re-resolves. `true` iff written.
 */
export async function writeCache(platformDir: string, cache: SidecarCache): Promise<boolean> {
  try {
    const path = sidecarPath(platformDir);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, `${JSON.stringify(cache, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Returns a new object; only `{ok:true}` results are stored. */
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
