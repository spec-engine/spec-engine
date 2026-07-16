// packages/tracker/src/types.ts — shared tracker contract types.
//
// These types are the fixed contract every later Phase 15 task (Linear adapter,
// sidecar cache, fences) implements against. They live in @spec-engine/tracker — NOT in
// @spec-engine/shared — so the engine→tracker import fence (Plan 04) stays clean: the
// engine may import a tracker *type* indirectly, but never the adapter surface.

/** Resolved issue metadata — the three fields every adapter returns on success. */
export interface TrackerMeta {
  title: string;
  status: string;
  url: string;
}

/**
 * Why a resolve degraded. The no-throw union (below) carries one of these on its
 * failure arm instead of throwing — the union IS the error channel (TRK-05).
 */
export type TrackerReason =
  | "absent"
  | "offline"
  | "unauthorized"
  | "rate_limited"
  | "not_found"
  | "server_error"
  | "timeout"
  | "malformed";

/**
 * No-throw discriminated union (TRK-05). The bare opaque `id` rides on BOTH arms
 * so every degraded path can still render the original id verbatim (TRK-05
 * foundation). resolveIssues never rejects — it always resolves to a Map of these.
 */
export type TrackerResult =
  | { ok: true; id: string; value: TrackerMeta }
  | { ok: false; id: string; reason: TrackerReason };
