const SCHEMA_BASE = "https://docs.spec-engine.dev/schema/v1";

/** The published JSON Schema for each file the engine reads. A v1 URL only ever changes additively. */
export const SCHEMA_URLS = {
  spec: `${SCHEMA_BASE}/spec.json`,
  check: `${SCHEMA_BASE}/check.json`,
  member: `${SCHEMA_BASE}/member.json`,
} as const;
