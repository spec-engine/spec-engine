// packages/shared/src/propagation.ts
//
// Propagation state machine for `spec propagation <KEY-NNN>` (PROP-02).
// Classifies each member repo's relationship to a given target requirement
// into one of five distinct states. `as const` object (not TS `enum`) so it
// survives verbatimModuleSyntax: true.
//
// WORK-02: shared package is runtime-free — this file has zero runtime imports
// (no `bun:sqlite`, no `node:*`). Types only.

export const PropagationState = {
  MIGRATED_VERIFIED: "MIGRATED_VERIFIED",
  MIGRATED_UNVERIFIED: "MIGRATED_UNVERIFIED",
  ON_PREDECESSOR: "ON_PREDECESSOR",
  ON_OTHER_DOMAIN_REQ: "ON_OTHER_DOMAIN_REQ",
  NO_DOMAIN_REFERENCE: "NO_DOMAIN_REFERENCE",
} as const;

export type PropagationState = (typeof PropagationState)[keyof typeof PropagationState];

export interface PropagationRow {
  repo: string;
  state: PropagationState;
  via_req_id: string | null;
  drifted: boolean;
}
