// packages/shared/src/storage.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec SCHM-002
//
// The Storage interface (D-07). Implemented exclusively by
// packages/engine/src/storage/sqlite.ts. Webapp consumes read methods
// over HTTP via spec serve in Phase 5; type-level: a single interface.

import type { DiagnosticCode } from "./diagnostics";
import type { PropagationRow } from "./propagation";

// --- Row types -----------------------------------------------------------

export interface Repo {
  name: string;
  path: string;
  pinned_spec_version: number;
  /**
   * Discovery-time hint (NEVER persisted): true when this Repo is the
   * platform directory registered as its OWN lone member — "single-repo /
   * rung-1 mode". Set by `discoverRepos` only when `spec-engine/` is present
   * and there are zero sibling members AND zero skipped siblings. The
   * pipeline reads it to exclude the in-repo `spec-engine/` subfolder from
   * the self-member's code scan. It is intentionally absent from the
   * schema.ts DDL and `upsertRepo` — the derived DB owns nothing
   * (CLAUDE.md invariant); this flag exists only between discover and the
   * pipeline's scan loop.
   */
  selfMember?: boolean;
  /**
   * Discovery-time hint (NEVER persisted): repo-relative directory prefixes
   * from this member's spec-engine.member.json `ignore` field (T7). The pipeline
   * appends them (normalized to a trailing slash) to the scanner's hardcoded
   * ignore list for THIS repo's code and doc scans. Like `selfMember`,
   * intentionally absent from the DDL and `upsertRepo`.
   */
  ignore?: readonly string[];
}

/**
 * A sibling directory under the platform root that exists but is NOT a
 * spec-check member because it lacks a `spec-engine.member.json`. Captured by
 * `discoverRepos` (DISC-02) for Phase 8's `NO_SPEC_CONFIG` diagnostic
 * emission. Only the "directory exists, config missing" case is captured —
 * loose files at the platform root and malformed configs are excluded.
 */
export interface SkippedRepo {
  /** The platform-relative sibling name (NEVER absolute). */
  name: string;
  /** Absolute path to the sibling directory. */
  path: string;
}

export interface Domain {
  key: string;
  owner: string | null;
  schema: string | null;
  spec_version: number;
  source_repo: string;
}

/**
 * The requirement status vocabulary — the single runtime source of truth.
 * The `RequirementStatus` type is DERIVED from this array so the value set and
 * the type can never drift. Previously the four values were re-materialized by
 * hand in three places (server/api.ts STATUSES, indexer/diagnostics.ts
 * VALID_STATUSES, and the api.ts "one of Active|Superseded|…" error string);
 * all now derive from here.
 */
export const REQUIREMENT_STATUSES = ["Active", "Superseded", "Draft", "Retired"] as const;
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
  spec_version: number; // see schema.ts version-semantics comment
  changed_at_version: number;
  // Envelope version this requirement was superseded/retired at, authored once
  // by `spec supersede`/`spec move` and never recomputed. `null` for Active
  // entries and for supersessions predating the field. See schema.ts.
  superseded_at_version: number | null;
}

/**
 * `implements` / `verifies` are path-derived from code tags (src vs test).
 * `documents` (RED-15) marks an explicit doc binding — `<!-- @spec KEY-NNN -->`
 * in a member's `.md` file. Documents-kind tags participate in integrity
 * checks that mean "this reference is stale/broken" (DANGLING_TAG,
 * SUPERSEDED_REFERENCED, and DRIFT — a behind-pinned repo whose doc still
 * cites a since-changed requirement is genuinely stale documentation, the
 * same family of signal). They are excluded everywhere a tag would claim
 * code coverage: the coverage VIEW's implemented/verified cases, ORPHAN_REQ
 * suppression, and the propagation state machine. One deliberate nuance:
 * the propagation `drifted` overlay reads the (kind-agnostic) drift VIEW,
 * so a repo whose ONLY reference to a changed requirement is documentary
 * can report `state: NO_DOMAIN_REFERENCE` with `drifted: true` — "no code
 * engagement, but its docs are behind".
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

/**
 * RED-16: one row per `**Relates:** …` entry — `from_id` (the requirement
 * carrying the field) → `to_id` (the requirement it links to).
 * `source_file`/`line` locate the Relates field line itself so the
 * RELATES_SUPERSEDED / BROKEN_RELATES diagnostics point at the authored
 * text. Self-references and duplicates are dropped at parse time; broken
 * targets are deliberately ALLOWED to land (Invariant #4 — validate via
 * diagnostics, never DB constraints).
 */
export interface RelationRow {
  from_id: string;
  to_id: string;
  source_file: string;
  line: number;
}

/**
 * TERM-01 (Phase 6): one row per glossary-term alias — `term_id` (the owning
 * TERM's id) → `name` (the synonym string). A minimal clone of `RelationRow`'s
 * derived-row posture: no FK/CHECK/UNIQUE at the DB (SCHM-07 / Invariant #4),
 * validated (if at all) via diagnostics, never a constraint. Present-and-empty
 * until Wave C flattens the requirement `aliases` field into rows.
 */
export interface TermAliasRow {
  term_id: string;
  name: string;
}

/**
 * TERM-01 (Phase 6): one row per pinned `cites` reference — `req_id` (the citing
 * requirement) → `term_id` (the cited TERM, NULLABLE: an unresolved citation
 * still lands so `spec check` can surface UNDEFINED_TERM). `cited_as` is the
 * authored surface form, `pinned_version` the TERM spec_version the citation was
 * pinned to (drift is TERM_DRIFT, not a structural reject — Invariant #4).
 * `source_file`/`line` locate the authored cite. A 1:1 clone of `RelationRow`'s
 * derived-row posture with the citation-specific columns.
 */
export interface TermCitationRow {
  req_id: string;
  term_id: string | null;
  cited_as: string | null;
  pinned_version: number | null;
  source_file: string;
  line: number;
}

/**
 * PROV-02 / PROV-04: one row per `**Issues:** role:ID` entry — `req_id` (the
 * requirement carrying the field) → `issue_id` (the external tracker payload
 * it names), tagged with a closed-allow-list `role`
 * (created | supersedes-via | amends-via). A 1:1 clone of `RelationRow` with
 * `from_id`→`req_id`, `to_id`→`issue_id`, plus the `role` column.
 * `source_file`/`line` locate the authored `**Issues:**` field line. Unknown
 * roles are surfaced (UNKNOWN_ROLE) AND dropped at parse time — never stored;
 * well-formed rows land unconditionally (Invariant #4 — validate via
 * diagnostics, never DB constraints).
 */
export interface ProvenanceRow {
  req_id: string;
  /**
   * OPAQUE payload string — an external tracker id (e.g. `ENG-1432`, or even a
   * deliberately `KEY-NNN`-shaped value). NEVER resolved/joined against
   * `requirements`, never used as a PK/FK/UNIQUE/index/JOIN key (PROV-02/SC3).
   * It is a plain stored value, nothing more.
   */
  issue_id: string;
  role: string; // created | supersedes-via | amends-via
  source_file: string;
  line: number;
}

/**
 * PMAT-01 / PMAT-04: the row shape of the WIDENED `provenance_matrix` SQL VIEW
 * (defined in schema.ts VIEWS_DDL) — one row per provenance link, joined to its
 * requirement (req_status) and aggregated coverage (backing-test columns).
 * Consumed by Phase 13's `spec provenance` surface (Plan 02/03). The VIEW is a
 * projection, never materialized (PMAT-04).
 */
export interface ProvenanceMatrixRow {
  req_id: string;
  role: string; // created | supersedes-via | amends-via
  /**
   * OPAQUE payload — never an identity key (PROV-02/SC3). In the widened VIEW
   * it is a purely projected column: the matrix joins ON req_id only, and
   * `provenanceByIssue` binds it as a `$issue` filter VALUE, never a routing,
   * coverage, JOIN, GROUP-BY, or index key.
   */
  issue_id: string;
  source_file: string;
  line: number; // git pointer per PMAT-01
  /**
   * The requirement's lifecycle status, projected verbatim from
   * `requirements.status` (a `TEXT NOT NULL` column with NO CHECK constraint,
   * by design — SCHM-07 / Invariant #4). A planted BAD_STATUS fixture carries
   * a value OUTSIDE the `RequirementStatus` union and flows through here (and
   * into the rendered header) verbatim so `spec check` can diagnose it. The
   * type is therefore widened to `RequirementStatus | string` so it does not
   * misrepresent the unconstrained source — WR-03 (13-REVIEW review-fix).
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
  /** Requirement id implicated by the structural defect, when available.
   *  Per WR-02 (03-REVIEW), populated for BROKEN_SUPERSEDE and BAD_STATUS
   *  (which are always defects on a specific `### KEY-NNN` requirement)
   *  and for the SECOND-seen DUP_ID occurrence (which carries the
   *  colliding id verbatim). null only when no specific id is implicated. */
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
   * TERM-07: the requirement's domain key, projected verbatim from
   * `requirements.key`. The discriminator the query formatter uses to split a
   * Terms group (`key === 'TERM'` — reserved glossary domain) from the
   * Requirements group. Terms ride the same `requirements_fts` index because
   * they ARE requirement rows; this key is what tells a term hit apart from an
   * ordinary requirement hit. NOT a coverage filter — the `key != 'TERM'`
   * exclusion belongs on the coverage VIEW (schema.ts), never on FTS.
   */
  key: string;
  text: string;
  why: string | null;
  rank: number; // bm25() score
  source_file: string;
  line: number;
}

// --- Drift + Semantic diagnostic row types (Phase 3 / plan 03-01) --------
//
// `DriftRow` is the row shape of the `drift` SQL VIEW (defined alongside
// `coverage` in schema.ts VIEWS_DDL). One row per (repo, req_id) where the
// repo's pin is behind the requirement's `changed_at_version`. CHCK-03: this
// VIEW is the single source of truth for drift — both `spec check` (Phase 3)
// and `spec propagation` (Phase 4) read from it via `listDriftRows()`.
export interface DriftRow {
  repo: string;
  req_id: string;
  source_file: string;
  line: number;
  domain_key: string;
  req_changed_at_version: number;
  repo_pin: number;
}

// `SemanticDiagnostic` is the row shape returned by `listSemanticDiagnostics()`,
// which UNIONs the five semantic diagnostic queries Q1..Q5 (DANGLING_TAG,
// SUPERSEDED_REFERENCED, DRIFT, ORPHAN_REQ, UNVERIFIED_REQ). Plan 03-02 wires
// the real queries; this plan exports the type so `Storage` can declare the
// method signature.
//
// `repo` and `req_id` are nullable because ORPHAN_REQ + UNVERIFIED_REQ scope
// to a requirement only (no specific repo), whereas DANGLING_TAG /
// SUPERSEDED_REFERENCED / DRIFT carry both. `severity` was the literal
// `"error"` until RED-16 — Q1..Q5 stay error-severity, but the Relates
// diagnostics (Q6 BROKEN_RELATES / Q7 RELATES_SUPERSEDED) are warnings, so
// the type now mirrors ParseDiagnostic's `"error" | "warning"`.
export interface SemanticDiagnostic {
  code: DiagnosticCode;
  repo: string | null;
  source_file: string;
  line: number;
  req_id: string | null;
  detail: string;
  severity: "error" | "warning";
}

// --- Storage interface ---------------------------------------------------
//
// Phase 1 stubs return [] / null / 0 where data isn't yet present.
// Phase 2 fills in upsertRepo/upsertDomain/upsertRequirement/upsertTag.
// Phase 3 fills in coverageMatrix / listDiagnostics / listDriftRows /
//   listSemanticDiagnostics with real query results.
// Phase 4 fills in searchFts / propagationFor.

export interface Storage {
  // --- Lifecycle / schema-version handling (Phase 1) ---
  /** Path the DB is bound to (for diagnostics / logging). */
  readonly path: string;

  /** Close the DB; releases the file handle. */
  close(): void;

  // --- Read operations (used by both CLI commands and webapp HTTP routes) ---
  listRepos(): Repo[];
  getRepo(name: string): Repo | null;
  listDomains(): Domain[];
  getDomain(key: string): Domain | null;
  listRequirements(opts?: { key?: string; status?: RequirementStatus }): Requirement[];
  getRequirement(id: string): Requirement | null;
  listTags(opts?: { repo?: string; req_id?: string; file?: string }): Tag[];
  listDiagnostics(): ParseDiagnostic[];
  /** Returns rows directly from the `drift` SQL VIEW. CHCK-03: this is the
   *  single source of truth for drift — both `spec check` (Phase 3) and
   *  `spec propagation` (Phase 4) consume it. No additional projection;
   *  the VIEW already encodes the predicate `r.changed_at_version >
   *  repos.pinned_spec_version AND tags(repo, req_id) exists`. */
  listDriftRows(): DriftRow[];
  /** Returns the UNION of the semantic diagnostic queries Q1..Q7:
   *  Q1..Q5 (DANGLING_TAG, SUPERSEDED_REFERENCED, DRIFT, ORPHAN_REQ,
   *  UNVERIFIED_REQ — all error severity, plan 03-02) plus the RED-16
   *  Relates pair Q6/Q7 (BROKEN_RELATES, RELATES_SUPERSEDED — warning
   *  severity). Mixed severities since RED-16; `spec check`'s exit code
   *  keys on error-severity rows only. */
  listSemanticDiagnostics(): SemanticDiagnostic[];
  /** RED-16: every `**Relates:**` link in the index, ordered by the full
   *  composite key (from_id, to_id, source_file, line) for deterministic
   *  output. The read seam RED-17's relation diagrams consume. */
  listRelations(): RelationRow[];
  /** TERM-01: every glossary-term alias in the index, ordered by the composite
   *  key (term_id, name) — the SAME order the computeBuildId `term_aliases`
   *  section hashes by. Present-and-empty until Wave C. */
  listTermAliases(): TermAliasRow[];
  /** TERM-01: every pinned `cites` citation in the index, ordered by the
   *  composite key (req_id, term_id, cited_as, source_file, line) — the SAME
   *  order the computeBuildId `term_citations` section hashes by. `term_id` is
   *  returned verbatim (nullable — an unresolved cite still lists). */
  listTermCitations(): TermCitationRow[];
  /** PROV-04: every `**Issues:**` provenance link in the index, ordered by the
   *  full composite key (req_id, role, issue_id, source_file, line) for
   *  deterministic output. `issue_id` is returned verbatim/opaque — never
   *  resolved against requirements (PROV-02/SC3). The read seam Phase 13's
   *  `provenance_matrix` surface consumes. */
  listProvenance(): ProvenanceRow[];
  /** PMAT-01/04: the widened provenance × coverage projection, ordered by the
   *  full composite key (req_id, role, issue_id, source_file, line). Reads the
   *  `provenance_matrix` VIEW directly — issue_id rides as a projected column
   *  only (PROV-02/SC3). */
  provenanceMatrix(): ProvenanceMatrixRow[];
  /** PMAT-03: the same matrix filtered to one opaque issue id, bound as a
   *  `$issue` WHERE param — issue_id is a filter VALUE, never a routing/coverage
   *  key (SC3). Never string-interpolated into the SQL. */
  provenanceByIssue(issueId: string): ProvenanceMatrixRow[];
  coverageMatrix(): CoverageRow[];
  searchFts(text: string, limit?: number): FtsHit[];
  /** Returns per-repo propagation state for the given target requirement.
   *  Each row carries `state: PropagationState` from the 5-state machine
   *  (PROP-02). The drift overlay (`drifted: boolean`) is merged in TS from
   *  a single `listDriftRows()` call — PROP-01 forbids redefining the drift
   *  predicate anywhere in Phase 4; the `drift` VIEW is the only source of
   *  truth (CHCK-03). SQL implementation lands in plan 04-02. */
  propagationFor(reqId: string): PropagationRow[];
  /** Returns the requirements tagged in any of the given files. */
  resolveByFiles(files: string[]): Requirement[];

  // --- Write operations (used by `spec index` in Phase 2) ---
  /** Begin a write transaction. All upsert* calls inside fn happen atomically;
   *  throw → automatic rollback (per Bun's db.transaction wrapper). */
  withWriteTx<T>(fn: (w: WriteHandle) => T): T;
}

export interface WriteHandle {
  clearAll(): void; // truncate everything before reindex
  upsertRepo(r: Repo): void;
  upsertDomain(d: Domain): void;
  upsertRequirement(r: Requirement): void;
  upsertTag(t: Omit<Tag, "id">): void;
  /** RED-16: insert one Relates link (pre-sorted by the pipeline). */
  upsertRelation(r: RelationRow): void;
  /** TERM-01: insert one glossary-term alias (pre-sorted by the pipeline on the
   *  composite key term_id, name). Present-and-empty until Wave C. */
  upsertTermAlias(a: TermAliasRow): void;
  /** TERM-01: insert one pinned `cites` citation (pre-sorted by the pipeline on
   *  the composite key req_id, term_id, cited_as, source_file, line). `term_id`
   *  is bound verbatim (nullable — an unresolved cite still lands, diagnosed at
   *  check time, never blocked at write time — Invariant #4). */
  upsertTermCitation(c: TermCitationRow): void;
  /** PROV-04: insert one `**Issues:**` provenance link (pre-sorted by the
   *  pipeline on the composite key req_id, role, issue_id, source_file, line).
   *  `issue_id` is bound as an opaque value — never a lookup/filter key. */
  upsertProvenance(p: ProvenanceRow): void;
  recordParseDiagnostic(d: Omit<ParseDiagnostic, "id">): void;
}
