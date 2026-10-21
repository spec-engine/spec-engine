import type { TrackerResult } from "./types";

export interface TrackerAdapter {
  readonly name: string;
  /** Whether this adapter claims the given opaque id. noop → true for all. */
  matches(id: string): boolean;
  /** Never rejects: every degraded path is the {ok:false} arm. */
  resolveIssues(ids: Iterable<string>): Promise<Map<string, TrackerResult>>;
}

/** No network call, env read, or secret access: the tracker fences assert this file stays pure. */
export const noopAdapter: TrackerAdapter = {
  name: "noop",
  matches: () => true,
  async resolveIssues(ids) {
    const out = new Map<string, TrackerResult>();
    for (const id of ids) out.set(id, { ok: false, id, reason: "absent" });
    return out;
  },
};
