// An `as const` object rather than a TS `enum`, so it survives
// verbatimModuleSyntax: true.
export const DiagnosticCode = {
  DUP_ID: "DUP_ID",
  BROKEN_SUPERSEDE: "BROKEN_SUPERSEDE",
  BAD_STATUS: "BAD_STATUS",
  DANGLING_TAG: "DANGLING_TAG",
  SUPERSEDED_REFERENCED: "SUPERSEDED_REFERENCED",
  DEPRECATED_REFERENCED: "DEPRECATED_REFERENCED",
  STATEMENT_GRAMMAR: "STATEMENT_GRAMMAR",
  DRAFT_REFERENCED: "DRAFT_REFERENCED",
  GLOSSARY_DRIFT: "GLOSSARY_DRIFT",
  ORPHAN_REQ: "ORPHAN_REQ",
  UNVERIFIED_REQ: "UNVERIFIED_REQ",
  DRIFT: "DRIFT",
  NO_SPEC_CONFIG: "NO_SPEC_CONFIG",
  BROKEN_FILE_REF: "BROKEN_FILE_REF",
  BROKEN_RELATES: "BROKEN_RELATES",
  RELATES_SUPERSEDED: "RELATES_SUPERSEDED",
  CYCLIC_SUPERSEDE: "CYCLIC_SUPERSEDE",
  SELF_RELATES: "SELF_RELATES",
  UNKNOWN_ROLE: "UNKNOWN_ROLE",
  UNSOURCED_CHANGE: "UNSOURCED_CHANGE",
  INVALID_DOMAIN_FILE: "INVALID_DOMAIN_FILE",
  UNPROVEN_REQ: "UNPROVEN_REQ",
  PROOFS_UNCONFIRMED: "PROOFS_UNCONFIRMED",
  REQUIREMENT_REMOVED: "REQUIREMENT_REMOVED",
  UNAPPROVED_STATUS_FLIP: "UNAPPROVED_STATUS_FLIP",
  PARTIAL_PROPAGATION: "PARTIAL_PROPAGATION",
  // @spec CHCK-016
  UNDEFINED_TERM: "UNDEFINED_TERM",
  // @spec CHCK-016
  ORPHAN_TERM: "ORPHAN_TERM",
  // @spec CHCK-018
  TERM_DRIFT: "TERM_DRIFT",
  // @spec CHCK-018
  SUPERSEDED_TERM_REFERENCED: "SUPERSEDED_TERM_REFERENCED",
} as const;

export type DiagnosticCode = (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

export interface Diagnostic {
  code: DiagnosticCode;
  source_file: string | null;
  line: number | null;
  repo: string | null;
  req_id: string | null;
  detail: string;
  severity: "error" | "warning";
}

/**
 * Thrown by `discoverRepos` when the resolved platform directory has no
 * `spec-engine/` subdirectory. A typed sentinel, so the command boundaries can
 * branch on it with `instanceof`.
 */
export class NotASpecPlatformError extends Error {
  public readonly platformDir: string;

  constructor(platformDir: string) {
    super(`Not a Spec Engine platform: no 'spec-engine/' directory under ${platformDir}`);
    this.name = "NotASpecPlatformError";
    this.platformDir = platformDir;
    // Preserve the prototype chain so `instanceof` survives transpilation.
    Object.setPrototypeOf(this, NotASpecPlatformError.prototype);
  }
}
