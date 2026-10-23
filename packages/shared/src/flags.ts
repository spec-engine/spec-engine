// An OFF feature is off on every surface: its nav entry, its page, and its
// write and API endpoints. Hiding a link is not turning a feature off.
// Unknown SPEC_FLAGS keys are ignored so a stale env var never crashes a
// newer binary.

/** The only registration step: nav, pages, and endpoints all read this map. */
// @spec SERV-032
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
    const known = FEATURE_KEYS.find((k) => k === key);
    if (known !== undefined) enabled.add(known);
  }
  return enabled;
}

/** Not memoized: tests toggle SPEC_FLAGS between requests. Every feature defaults OFF. */
export function featureEnabled(key: FeatureKey): boolean {
  return parseFlags(process.env.SPEC_FLAGS).has(key);
}

export function featureDisabledMessage(key: FeatureKey): string {
  return `${FEATURES[key].label} is not enabled (coming soon). To try it locally, run with SPEC_FLAGS=${key}.`;
}
