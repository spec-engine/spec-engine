// The only engine module besides commands/ permitted to import the tracker
// package: the index-building internals make no network call, and an
// architecture fence holds that boundary. The token is read only inside the
// adapter; this file never reads, logs, or persists it. The cache is the
// tracker's JSON sidecar, never the derived index.

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

/** Never throws: `resolveIssues` is no-throw and `writeCache` is best-effort. */
export async function resolveAndCache(
  rows: ProvenanceMatrixRow[],
  platformDir: string,
  adapter: TrackerAdapter = makeLinearAdapter(),
  now: number = Date.now(),
): Promise<Map<string, ResolvedShape>> {
  const ids = rows.map((r) => r.issue_id);
  const uniqueIds = [...new Set(ids)];

  const cache = await readCache(platformDir);
  const toResolve = uniqueIds.filter((id) => {
    const entry = cache[id];
    return entry === undefined || !isFresh(entry, now);
  });

  const results: Map<string, TrackerResult> =
    toResolve.length > 0 ? await adapter.resolveIssues(toResolve) : new Map();

  // A stale entry whose re-resolve fails is kept and served stale: better a
  // slightly-old title than a fully-degraded row when the tracker is
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

  // `/api/provenance?resolve=1` is a read-only GET: the degraded and all-fresh
  // paths must stay side-effect-free.
  if (changed) await writeCache(platformDir, next);

  // `reason` is dropped so the decorator cannot tell absent from failed.
  // @spec PROV-002
  const out = new Map<string, ResolvedShape>();
  for (const id of uniqueIds) {
    const entry: CacheEntry | undefined = next[id];
    out.set(
      id,
      entry
        ? {
            ok: true,
            title: entry.title,
            status: entry.status,
            url: entry.url,
            stale: !isFresh(entry, now),
          }
        : { ok: false },
    );
  }
  return out;
}
