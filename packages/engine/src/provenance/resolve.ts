// packages/engine/src/provenance/resolve.ts
//
// Phase 16 Plan 01 (PWEB-02): the SURFACE-layer resolve seam. This is the ONLY
// engine module (besides commands/provenance.ts) permitted to import the tracker
// adapter package — it is the composition root for the opt-in `--resolve-issues`
// online edge. The index-building ENGINE INTERNALS (indexer/parser/storage/
// scanner/check) import NOTHING from the adapter and make no network call; this
// file is where that boundary lives (Plan 03 narrows the CI fence to enforce it).
//
// Lifecycle (2.3, revised): readCache → serve FRESH cache entries directly and
// resolve only misses/stale via adapter.resolveIssues (no-throw) → fold new
// successes into the cache (stale entries kept + served on failure) →
// writeCache only when something changed (best-effort, sidecar only — NEVER the
// index) → project each served id into the plain ResolvedShape the pure
// decorator in format.ts consumes. The projection DELIBERATELY drops `reason`:
// an absent adapter and a failed adapter both become `{ ok: false }`, so the
// decorator renders byte-identical degraded output for either (PWEB-03).
//
// Token handling (Phase 15 fence): the token is read ONLY inside the adapter
// (makeLinearAdapter); this file never reads, logs, or persists it — only
// {title,status,url} for ok:true hits lands in the sidecar.
//
// D-08 grep-fence: this file does not import bun:sqlite. Caching goes through the
// tracker package's JSON sidecar helpers, never the derived index.

import type { ProvenanceMatrixRow } from "@spec-engine/shared";
import {
  type CacheEntry,
  isFresh,
  makeLinearAdapter,
  readCache,
  type SidecarCache,
  type TrackerAdapter,
  type TrackerResult,
  writeCache,
} from "@spec-engine/tracker";
import type { ResolvedShape } from "./format";

/**
 * Resolve the opaque issue ids on `rows` against the tracker, persisting ok:true
 * hits into the Phase 15 non-hashed sidecar at `<platformDir>/.spec-engine/`, and
 * return the plain `Map<issue_id, ResolvedShape>` the decorator renders through.
 *
 * `adapter` defaults to `makeLinearAdapter()` (degrades to {ok:false} with no
 * network call when SPEC_TRACKER_TOKEN is unset) and is injectable for tests.
 * Never throws — `resolveIssues` is no-throw and `writeCache` is best-effort.
 */
export async function resolveAndCache(
  rows: ProvenanceMatrixRow[],
  platformDir: string,
  adapter: TrackerAdapter = makeLinearAdapter(),
  now: number = Date.now(),
): Promise<Map<string, ResolvedShape>> {
  const ids = rows.map((r) => r.issue_id);
  const uniqueIds = [...new Set(ids)];

  // 2.3: the cache is now actually SERVED. Read the sidecar, then split the ids:
  // a FRESH cached entry (fetched_at within the TTL) is served without touching
  // the network; only MISSES and STALE entries are resolved. Previously every
  // id was re-fetched every call and `fetched_at` was written but never read —
  // a warm cache gave zero benefit and offline runs degraded fully.
  const cache = await readCache(platformDir);
  const toResolve = uniqueIds.filter((id) => {
    const entry = cache[id];
    return entry === undefined || !isFresh(entry, now);
  });

  const results: Map<string, TrackerResult> =
    toResolve.length > 0 ? await adapter.resolveIssues(toResolve) : new Map();

  // Fold newly-resolved successes into the cache (updating the fetched_at
  // stamp). A stale entry whose re-resolve FAILS is kept and served stale —
  // better a slightly-old title than a fully-degraded row when the tracker is
  // momentarily unreachable.
  const next: SidecarCache = { ...cache };
  const fetchedAt = new Date(now).toISOString();
  let changed = false;
  for (const [id, result] of results) {
    if (result.ok) {
      next[id] = { ...result.value, fetched_at: fetchedAt };
      changed = true;
    }
  }

  // `/api/provenance?resolve=1` is a read-only GET (T-5-03-05): persist ONLY
  // when a real new/updated entry was cached, so the degraded/all-fresh paths
  // stay side-effect-free.
  if (changed) await writeCache(platformDir, next);

  // Project each served id → ResolvedShape, DROPPING `reason` so the decorator
  // cannot distinguish absent from failed (parity by construction). Serve order:
  // a fresh/updated cache entry wins; on a miss with a failed resolve, {ok:false}.
  const out = new Map<string, ResolvedShape>();
  for (const id of uniqueIds) {
    const entry: CacheEntry | undefined = next[id];
    out.set(
      id,
      entry
        ? { ok: true, title: entry.title, status: entry.status, url: entry.url }
        : { ok: false },
    );
  }
  return out;
}
