// @spec SCHM-041
// Implemented only by packages/engine/src/storage/sqlite.ts.

import type { DiagnosticCode } from "./diagnostics";
import type { PropagationRow } from "./propagation";

export interface Repo {
  name: string;
  path: string;
  pinned_spec_version: number;
  /** Providers before consumers: 0 with no in-platform dependency, else one more than its deepest. */
  dependency_depth: number;
  /**
   * Discovery-time hint, never persisted: a lone repository that is its own
   * coverage column, whose scan skips its in-repo `spec-engine/` folder.
   */
  selfMember?: boolean;
  /** Discovery-time hint, never persisted: the member config's `ignore` prefixes. */
  ignore?: readonly string[];
}

export interface Domain {
  key: string;
  owner: string | null;
  schema: string | null;
  spec_version: number;
  source_repo: string;
}

/** The runtime source of `RequirementStatus`; the type derives from it so they cannot drift. */
export const REQUIREMENT_STATUSES = ["Active", "Superseded", "Draft", "Deprecated"] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export interface Requirement {
  id: string; // e.g. "BILLING-009"
  key: string; // e.g. "BILLING"
  seq: number; // 9
  status: RequirementStatus;
  superseded_by: string | null;
  text: string;
  why: string | null;
  source_file: string;
  line: number;
  spec_version: number;
  changed_at_version: number;
  // Authored once at supersession, never recomputed. null for Active entries
  // and for supersessions that predate the field.
  superseded_at_version: number | null;
}

/**
 * `documents` tags count for staleness checks (DANGLING_TAG,
 * SUPERSEDED_REFERENCED, DRIFT) but never as code coverage. The propagation
 * `drifted` overlay reads the kind-agnostic drift VIEW, so a repo whose only
 * reference is a doc can be `NO_DOMAIN_REFERENCE` with `drifted: true`.
 */
export type TagKind = "implements" | "verifies" | "documents";
export type TagLevel = "unit" | "integration" | "e2e" | null;

export interface Tag {
  id: number;
  req_id: string;
  repo: string;
  file: string;
  line: number;
  kind: TagKind;
  level: TagLevel;
}

export interface ImplementingSite {
  repo: string;
  file: string;
  line: number;
  kind: Exclude<TagKind, "verifies">;
}

export interface VerifyingSite {
  repo: string;
  file: string;
  line: number;
  level: TagLevel;
}

/** A requirement row with the code sites its tags name, each list sorted by (repo, file, line). */
export interface RequirementRecord extends Requirement {
  implemented_in: ImplementingSite[];
  verified_in: VerifyingSite[];
}

/** Broken targets land on purpose: they are diagnosed, never constrained in the DB. */
export interface RelationRow {
  from_id: string;
  to_id: string;
  source_file: string;
  line: number;
}

export interface TermAliasRow {
  term_id: string;
  name: string;
}

/** `term_id` is nullable: an unresolved citation still lands so `spec check` reports UNDEFINED_TERM. */
export interface TermCitationRow {
  req_id: string;
  term_id: string | null;
  cited_as: string | null;
  pinned_version: number | null;
  source_file: string;
  line: number;
}

/** Unknown roles are reported (UNKNOWN_ROLE) and dropped at parse time, never stored. */
export interface ProvenanceRow {
  req_id: string;
  /** Opaque tracker payload, even when KEY-NNN-shaped: never resolved against `requirements` or used as a key. */
  issue_id: string;
  role: string; // created | supersedes-via | amends-via
  source_file: string;
  line: number;
}

export interface ProvenanceMatrixRow {
  req_id: string;
  role: string; // created | supersedes-via | amends-via
  /** Opaque: a projected column and a bound filter value, never a join, group, or index key. */
  issue_id: string;
  source_file: string;
  line: number;
  /**
   * Widened past the union: `requirements.status` has no CHECK, so a planted
   * BAD_STATUS flows through verbatim for `spec check` to diagnose.
   */
  req_status: RequirementStatus | string;
  implemented: 0 | 1;
  verified: 0 | 1;
  test_levels: string | null; // GROUP_CONCAT result; may be NULL when no coverage
}

export interface ParseDiagnostic {
  id: number;
  code: DiagnosticCode;
  source_file: string;
  line: number;
  /** Null only when no specific requirement is implicated; DUP_ID carries the second occurrence's id. */
  req_id: string | null;
  detail: string;
  severity: "error" | "warning";
}

export interface CoverageRow {
  req_id: string;
  domain_key: string;
  req_status: RequirementStatus;
  req_spec_version: number;
  req_changed_at_version: number;
  repo: string;
  repo_pin: number;
  implemented: 0 | 1;
  verified: 0 | 1;
  test_levels: string | null; // GROUP_CONCAT result; may be NULL
}

export interface FtsHit {
  req_id: string;
  /**
   * Splits term hits (`TERM`) from requirement hits in the query output. Not a
   * coverage filter: the TERM exclusion belongs on the coverage VIEW, never on FTS.
   */
  key: string;
  text: string;
  why: string | null;
  rank: number; // bm25() score
  source_file: string;
  line: number;
}

// The `drift` VIEW is the one source of truth for drift; `spec check` and
// `spec propagation` both read it through `listDriftRows()`.
export interface DriftRow {
  repo: string;
  req_id: string;
  source_file: string;
  line: number;
  domain_key: string;
  req_changed_at_version: number;
  repo_pin: number;
}

// `repo` and `req_id` are null for the requirement-scoped codes (ORPHAN_REQ,
// UNVERIFIED_REQ).
export interface SemanticDiagnostic {
  code: DiagnosticCode;
  repo: string | null;
  source_file: string;
  line: number;
  req_id: string | null;
  detail: string;
  severity: "error" | "warning";
}

export interface Storage {
  readonly path: string;

  close(): void;

  listRepos(): Repo[];
  getRepo(name: string): Repo | null;
  listDomains(): Domain[];
  getDomain(key: string): Domain | null;
  listRequirements(opts?: {
    key?: string | undefined;
    status?: RequirementStatus | undefined;
  }): Requirement[];
  getRequirement(id: string): Requirement | null;
  listTags(opts?: { repo?: string; req_id?: string; file?: string }): Tag[];
  listDiagnostics(): ParseDiagnostic[];
  /** No projection on top: the VIEW already encodes the drift predicate. */
  listDriftRows(): DriftRow[];
  /** Mixed severities: `spec check`'s exit code keys on error rows only. */
  listSemanticDiagnostics(): SemanticDiagnostic[];
  /** Ordered by (from_id, to_id, source_file, line). */
  listRelations(): RelationRow[];
  /** Ordered by (term_id, name), the order computeBuildId hashes by. */
  listTermAliases(): TermAliasRow[];
  /** Ordered by (req_id, term_id, cited_as, source_file, line), the order computeBuildId hashes by. */
  listTermCitations(): TermCitationRow[];
  /** Ordered by (req_id, role, issue_id, source_file, line). */
  listProvenance(): ProvenanceRow[];
  /** Ordered by (req_id, role, issue_id, source_file, line). */
  provenanceMatrix(): ProvenanceMatrixRow[];
  /** `issueId` is bound as a `$issue` parameter, never interpolated into the SQL. */
  provenanceByIssue(issueId: string): ProvenanceMatrixRow[];
  coverageMatrix(): CoverageRow[];
  searchFts(text: string, limit?: number): FtsHit[];
  /** The `drifted` overlay is merged in TS from `listDriftRows()`; never redefine the drift predicate here. */
  propagationFor(reqId: string): PropagationRow[];
  resolveByFiles(files: string[]): Requirement[];

  /** A throw inside `fn` rolls the whole transaction back. */
  withWriteTx<T>(fn: (w: WriteHandle) => T): T;
}

export interface WriteHandle {
  clearAll(): void;
  upsertRepo(r: Repo): void;
  upsertDomain(d: Domain): void;
  upsertRequirement(r: Requirement): void;
  upsertTag(t: Omit<Tag, "id">): void;
  upsertRelation(r: RelationRow): void;
  upsertTermAlias(a: TermAliasRow): void;
  /** `term_id` may be null: an unresolved cite lands and is diagnosed at check time. */
  upsertTermCitation(c: TermCitationRow): void;
  upsertProvenance(p: ProvenanceRow): void;
  recordParseDiagnostic(d: Omit<ParseDiagnostic, "id">): void;
}
