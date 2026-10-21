// An `as const` object, not a TS `enum`, so it survives verbatimModuleSyntax.

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
