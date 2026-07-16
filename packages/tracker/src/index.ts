// packages/tracker/src/index.ts — barrel export for the @spec-engine/tracker package.

export type { TrackerAdapter } from "./adapter";
export { noopAdapter } from "./adapter";
export type { CacheEntry, SidecarCache } from "./cache";
export {
  CACHE_TTL_MS,
  isFresh,
  mergeResolved,
  readCache,
  SIDECAR_FILE,
  sidecarPath,
  writeCache,
} from "./cache";
export { linearAdapter, makeLinearAdapter } from "./linear";
export type { TrackerMeta, TrackerReason, TrackerResult } from "./types";
