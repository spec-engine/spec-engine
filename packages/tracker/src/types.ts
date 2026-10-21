// These live here, not in @spec-engine/shared, so the engine never reaches the
// adapter surface through a shared import.

export interface TrackerMeta {
  title: string;
  status: string;
  url: string;
}

/** The failure arm carries one of these instead of throwing: the union is the error channel. */
export type TrackerReason =
  | "absent"
  | "offline"
  | "unauthorized"
  | "rate_limited"
  | "not_found"
  | "server_error"
  | "timeout"
  | "malformed";

/** The opaque `id` rides on both arms so a degraded path still renders it verbatim. */
export type TrackerResult =
  | { ok: true; id: string; value: TrackerMeta }
  | { ok: false; id: string; reason: TrackerReason };
