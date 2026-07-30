// packages/shared/src/flags.ts
//
// The one feature-flag surface for the whole platform (D4a decided
// 2026-07-30: every coming-soon feature is planned and stays, behind this
// single system — no per-file constants, no paid or hosted service; flags are
// code shipped with the binary).
//
// A feature that is OFF is off everywhere it has a surface: its nav entry
// shows "coming soon", its page serves the coming-soon document, and its
// write/API endpoints refuse — hiding a link is not turning a feature off.
//
// Local override for development: SPEC_FLAGS is a comma-separated list of
// feature keys to enable (e.g. `SPEC_FLAGS=editor,query spec serve .`).
// Unknown keys are ignored so a stale env var never crashes a newer binary.

/** Every flaggable feature. Adding one here is the ONLY registration step —
 *  nav, pages, and endpoints all read this map. */
// @spec SERV-006
// @spec SERV-007
export const FEATURES = {
  glossary: { label: "Glossary" },
  relations: { label: "Relations" },
  provenance: { label: "Provenance" },
  query: { label: "Query" },
  editor: { label: "Editor" },
  logs: { label: "Logs" },
} as const;

export type FeatureKey = keyof typeof FEATURES;

const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

/** Parse a SPEC_FLAGS-style value into the enabled set. Unknown or empty
 *  entries are ignored; whitespace and case are forgiven. */
export function parseFlags(value: string | undefined): ReadonlySet<FeatureKey> {
  const enabled = new Set<FeatureKey>();
  for (const rawKey of (value ?? "").split(",")) {
    const key = rawKey.trim().toLowerCase();
    if ((FEATURE_KEYS as string[]).includes(key)) enabled.add(key as FeatureKey);
  }
  return enabled;
}

/** Whether `key` is enabled right now. Reads the SPEC_FLAGS environment
 *  variable on every call (no memoization — a few string ops, and tests can
 *  toggle the env between requests). All features default OFF. */
export function featureEnabled(key: FeatureKey): boolean {
  return parseFlags(process.env.SPEC_FLAGS).has(key);
}

/** The message an OFF feature's API endpoints respond with. */
export function featureDisabledMessage(key: FeatureKey): string {
  return `${FEATURES[key].label} is not enabled (coming soon). To try it locally, run with SPEC_FLAGS=${key}.`;
}
