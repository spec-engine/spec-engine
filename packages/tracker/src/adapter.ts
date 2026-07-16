// packages/tracker/src/adapter.ts — the generic adapter interface + offline default.

import type { TrackerResult } from "./types";

/**
 * The generic tracker adapter. Both the offline `noopAdapter` and the future
 * concrete `linearAdapter` implement this single interface, so the engine/Phase 16
 * select one by config and a second tracker drops in without contract changes
 * (TRK-03).
 */
export interface TrackerAdapter {
  /** Adapter identity, e.g. "noop" | "linear". */
  readonly name: string;
  /** Whether this adapter claims the given opaque id. noop → true for all. */
  matches(id: string): boolean;
  /**
   * Resolve opaque ids to a Map of no-throw results. NEVER rejects — every
   * degraded path is encoded on the {ok:false} arm of TrackerResult.
   */
  resolveIssues(ids: Iterable<string>): Promise<Map<string, TrackerResult>>;
}

/**
 * Offline-first default adapter. It matches every id and degrades every id to the
 * bare opaque id with reason "absent" — WITHOUT any network call, env read, or
 * secret access. This purity is what Plan 04's fences assert (no network call, no
 * environment read in this file).
 */
export const noopAdapter: TrackerAdapter = {
  name: "noop",
  matches: () => true,
  async resolveIssues(ids) {
    const out = new Map<string, TrackerResult>();
    for (const id of ids) out.set(id, { ok: false, id, reason: "absent" });
    return out;
  },
};
