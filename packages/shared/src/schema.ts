// packages/shared/src/schema.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec SCHM-001
// @spec PROP-002
//
// Phase 1 contract — frozen schema vocabulary for the Spec Engine derived index.
// Phases 2–6 import SCHEMA_VERSION and DDL from this module; no .sql files exist.
//
// VERSION SEMANTICS — quoted verbatim by Phase 3's DRIFT predicate (D-02):
//
//   domains.spec_version          The domain's current spec version (the SPEC.json
//                                 envelope's `specVersion`). Bumped when ANY requirement
//                                 in the domain is added, amended, or superseded.
//
//   requirements.spec_version     The domain version at which this requirement was
//                                 last INTRODUCED or REAFFIRMED. For an unchanged Active
//                                 req in v2's SPEC.md, this is the version where it
//                                 originally appeared (e.g., BILLING-007 = 1).
//
//   requirements.changed_at_version  The domain version of the last semantically
//                                 meaningful change to this requirement (supersede,
//                                 amend, status change). For BILLING-001 (superseded
//                                 at v2) this is 2. For BILLING-007 (unchanged since
//                                 v1) this is 1. For a fresh BILLING-009 at v2, this
//                                 is 2. NOTE: for a superseded entry the index
//                                 FORCES this to the CURRENT envelope version, so it
//                                 drifts upward on every later bump — do not read it
//                                 as "the version it died at". Use
//                                 superseded_at_version for that.
//
//   requirements.superseded_at_version  The envelope version at the exact moment this
//                                 requirement was superseded/retired, authored ONCE by
//                                 `spec supersede`/`spec move` and never recomputed
//                                 (nullable). This is the stable "died at v2" value;
//                                 NULL for Active entries and for supersessions that
//                                 predate the field (unrecoverable — no back-fill).
//
//   repos.pinned_spec_version     The member's declared pin (read from each
//                                 repo's spec-engine.member.json `specs: "spec-engine@N"`).
//
// DRIFT predicate (Phase 3, single SQL VIEW):
//   r.changed_at_version > repos.pinned_spec_version  AND  tags(repo, req_id) exists.
//   A repo is drifted ONLY for requirements it actually references.

// Phase 3 / plan 03-01: bumped 1 → 2 to accommodate the new `drift` VIEW.
// Phase 3 / WR-02 review-fix: bumped 2 → 3 to add `parse_diagnostics.req_id`
// (nullable) so the structural→semantic adapter can preserve BAD_STATUS and
// BROKEN_SUPERSEDE req_ids that the parser already knows. Any sqlite_master
// delta changes the on-disk shape — existing older fixture DBs triggering
// D-12's silent rebuild branch in storage/sqlite.ts:75-96 is the intended
// migration story. CI smoke 4 (`__schema-mismatch-smoke`) exercises that
// rebuild path and remains green after the bump.
// Phase 4 / plan 04-01: bumped 3 → 4 to add `tokenize='porter unicode61'` to
// the `requirements_fts` virtual table so QURY-02 (`spec query "renewal
// charge"` matches BILLING-009 text "When a subscription renews, charge ...")
// works via Porter stemming (`renewal` ↔ `renews` reduce to the same stem
// `renew`). The default unicode61 tokenizer does no stemming. Existing v3 DBs
// route through D-12's silent rebuild branch — no data migration needed
// because the derived index is rebuildable from source (Invariant #1).
// RED-16: bumped 4 → 5 to add the `relations` table (one row per
// `**Relates:**` link). Existing v4 DBs route through D-12's silent
// rebuild branch as with every prior bump.
// Phase 12 (PROV): bumped 5 → 6 to add the provenance table +
// provenance_matrix VIEW. Existing v5 DBs route through D-12's silent
// rebuild branch as with every prior bump.
// Phase 13 (PMAT): bumped 6 → 7 to widen provenance_matrix with the
// requirements + coverage join (req_status + backing-test columns per
// provenance link); existing v6 DBs route through D-12's silent rebuild
// branch and pick up the widened VIEW.
// Phase 13 / WR-01 review-fix: bumped 7 → 8 to correct the
// provenance_matrix.test_levels aggregation — it now re-aggregates at the
// individual-level granularity via a correlated subquery over `tags`
// (DISTINCT t2.level ORDER BY level) instead of GROUP_CONCAT(DISTINCT
// c.test_levels), which double-counted a level present in multiple repos.
// The VIEW DDL string changed → existing v7 DBs route through D-12's silent
// rebuild branch and pick up the corrected VIEW.
// Phase 6 (TERM): bumped 8 → 9 to add the TERM-store substrate — the
// `term_aliases` + `term_citations` derived tables (cloned 1:1 from
// `relations`, present-and-empty until Wave C wires the flatten), the
// `term_drift` VIEW, and the `WHERE r.key != 'TERM'` exclusion on the coverage
// VIEW (a glossary TERM is a requirement row but NOT a code-coverage
// obligation). Existing v8 DBs route through D-12's silent cold-rebuild branch
// as with every prior bump — no data migration (the index is disposable,
// Invariant #1). @spec SCHM-005
export const SCHEMA_VERSION = 10;

/**
 * Upper bound on the number of file inputs accepted by `spec resolve`
 * (CLI seam) and `/api/resolve` (HTTP seam), and enforced defensively at
 * the storage seam (`resolveByFiles`). One named constant so a future
 * loosening of the limit only requires touching this file (Phase 5 WR-01
 * iter3).
 *
 * Sized well below SQLITE_MAX_VARIABLE_NUMBER (32766 in Bun's bundled
 * SQLite) so the IN-clause spread cannot exceed the bind-parameter ceiling.
 */
export const FILES_MAX = 1000;

/**
 * Query-result bounds shared by the CLI (`spec query --limit`), the MCP
 * `spec_query` tool, and the HTTP `?limit=` param — one contract so the three
 * front-ends can't disagree on the default or the ceiling (the ceiling is also
 * a DoS bound, T-5-03-04). Previously `1000`/`10` were re-spelled at ~8 sites.
 */
export const DEFAULT_QUERY_LIMIT = 10;
export const LIMIT_MAX = 1000;

// --- TABLES_DDL ----------------------------------------------------------

const TABLES_DDL = `
-- _schema_version: single-row table holding the integer schema_version on disk.
-- Engine reads this on open; if it doesn't match SCHEMA_VERSION, the DB is wiped
-- and rebuilt from scratch (D-12).
CREATE TABLE IF NOT EXISTS _schema_version (
  version INTEGER NOT NULL
);

-- Per D-03 / SCHM-07: NO CHECK / FK / UNIQUE on domain fields. PRIMARY KEY only.
CREATE TABLE IF NOT EXISTS repos (
  name                  TEXT PRIMARY KEY,
  path                  TEXT NOT NULL,
  pinned_spec_version   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS domains (
  key                   TEXT PRIMARY KEY,
  owner                 TEXT,
  schema                TEXT,
  spec_version          INTEGER NOT NULL,
  source_repo           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requirements (
  id                    TEXT PRIMARY KEY,
  key                   TEXT NOT NULL,
  seq                   INTEGER NOT NULL,
  status                TEXT NOT NULL,
  superseded_by         TEXT,
  text                  TEXT NOT NULL,
  why                   TEXT,
  source_file           TEXT NOT NULL,
  line                  INTEGER NOT NULL,
  spec_version          INTEGER NOT NULL,
  changed_at_version    INTEGER NOT NULL,
  superseded_at_version INTEGER
);

CREATE TABLE IF NOT EXISTS tags (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id                TEXT NOT NULL,
  repo                  TEXT NOT NULL,
  file                  TEXT NOT NULL,
  line                  INTEGER NOT NULL,
  kind                  TEXT NOT NULL,
  level                 TEXT
);
CREATE INDEX IF NOT EXISTS idx_tags_by_req  ON tags(req_id);
CREATE INDEX IF NOT EXISTS idx_tags_by_repo ON tags(repo);
CREATE INDEX IF NOT EXISTS idx_tags_by_file ON tags(file);

-- relations (RED-16): one row per **Relates:** link in a SPEC.md entry.
-- from_id carries the field; to_id is the linked requirement. Per
-- Invariant #4 there is NO FK — a to_id pointing at a missing requirement
-- lands verbatim so spec check can surface BROKEN_RELATES; a to_id whose
-- requirement was superseded surfaces RELATES_SUPERSEDED. source_file +
-- line locate the authored Relates field line.
CREATE TABLE IF NOT EXISTS relations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  source_file   TEXT NOT NULL,
  line          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id);
CREATE INDEX IF NOT EXISTS idx_relations_to   ON relations(to_id);

-- term_aliases (TERM-01, Phase 6): one row per glossary-term alias. Cloned 1:1
-- from the relations table — id AUTOINCREMENT (excluded from build_id), no
-- FK/CHECK/UNIQUE (SCHM-07 / Invariant #4, or the arch-fence trips). term_id is
-- the owning TERM's id; name the synonym string. Present-and-empty until Wave C
-- flattens the requirement aliases field into rows.
CREATE TABLE IF NOT EXISTS term_aliases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id       TEXT NOT NULL,
  name          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_term_aliases_term ON term_aliases(term_id);
CREATE INDEX IF NOT EXISTS idx_term_aliases_name ON term_aliases(name);

-- term_citations (TERM-01, Phase 6): one row per pinned cites reference from a
-- requirement to a glossary TERM. Cloned from the relations table: id
-- AUTOINCREMENT (excluded from build_id), NO FK/CHECK/UNIQUE (SCHM-07 /
-- Invariant #4) — a term_id pointing at a missing/superseded TERM lands verbatim
-- so spec check can surface UNDEFINED_TERM / TERM_DRIFT (Wave D). req_id carries
-- the citing requirement; term_id the cited TERM (nullable — an unresolved cite
-- still lands); cited_as the authored surface form; pinned_version the term
-- spec_version the citation was pinned to; source_file + line locate the cite.
-- Present-and-empty until Wave C wires the flatten.
CREATE TABLE IF NOT EXISTS term_citations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id         TEXT NOT NULL,
  term_id        TEXT,
  cited_as       TEXT,
  pinned_version INTEGER,
  source_file    TEXT NOT NULL,
  line           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_term_citations_req  ON term_citations(req_id);
CREATE INDEX IF NOT EXISTS idx_term_citations_term ON term_citations(term_id);

-- provenance (PROV-02 / PROV-04): one row per **Issues:** role:ID link in a
-- SPEC.md entry. req_id carries the field; issue_id is the OPAQUE external
-- tracker payload; role is a closed-allow-list label (created | supersedes-via
-- | amends-via), validated at PARSE time, never as a DB constraint (SCHM-07 /
-- Invariant #4). source_file + line locate the authored **Issues:** field line.
-- Exactly ONE index, on req_id (SC3) — never on issue_id, which would read as
-- treating the opaque payload as a lookup key (PROV-02, grep-fenced in Plan 04).
-- @spec PROV-001
CREATE TABLE IF NOT EXISTS provenance (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id        TEXT NOT NULL,
  issue_id      TEXT NOT NULL,   -- OPAQUE payload string — never PK/FK/UNIQUE/JOIN key (PROV-02/SC3)
  role          TEXT NOT NULL,   -- created | supersedes-via | amends-via
  source_file   TEXT NOT NULL,
  line          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provenance_by_req ON provenance(req_id);  -- ONLY index, on req_id (SC3)

-- parse_diagnostics: structural diagnostics carried forward from Phase 2's
-- validate-on-parse pass (DUP_ID, BROKEN_SUPERSEDE, BAD_STATUS). Stored so
-- spec check can render them with file+line; not used by Phase 1's smoke.
-- req_id is nullable per WR-02 (03-REVIEW): the parser knows the implicated
-- id for BROKEN_SUPERSEDE and BAD_STATUS, and for the SECOND DUP_ID
-- occurrence. NULL when no specific id is implicated.
CREATE TABLE IF NOT EXISTS parse_diagnostics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL,
  source_file   TEXT NOT NULL,
  line          INTEGER NOT NULL,
  req_id        TEXT,
  detail        TEXT NOT NULL,
  severity      TEXT NOT NULL
);
`;

// --- FTS_DDL -------------------------------------------------------------
// D-01: external-content FTS5 over requirements.text + requirements.why.
// content_rowid='rowid' uses SQLite's implicit INTEGER rowid (NOT requirements.id,
// because that's TEXT). Triggers (TRIGGERS_DDL below) keep FTS in sync inside
// the same write transaction.

const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS requirements_fts USING fts5(
  text,
  why,
  content='requirements',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
`;

// --- VIEWS_DDL -----------------------------------------------------------
// D-04 / SCHM-06: coverage is a VIEW, never materialized.
// CROSS JOIN repos LEFT JOIN tags produces the N×M matrix Phase 3's map renders.
//
// CHCK-03 / D-04 / Invariant #3: `drift` is a VIEW, never materialized. The
// predicate is quoted verbatim from the version-semantics comment block above
// (lines 27-29). Consumed by `spec check` (Phase 3) and `spec propagation`
// (Phase 4); defining it in one place is the structural enforcement of "one
// predicate, one place". INNER JOIN against requirements (not LEFT JOIN): a
// tag without a matching req is a DANGLING_TAG, NOT a DRIFT — those are
// separate diagnostics, scoped distinctly by the semantic-diagnostic queries.

const VIEWS_DDL = `
CREATE VIEW IF NOT EXISTS coverage AS
SELECT
  r.id                            AS req_id,
  r.key                           AS domain_key,
  r.status                        AS req_status,
  r.spec_version                  AS req_spec_version,
  r.changed_at_version            AS req_changed_at_version,
  repos.name                      AS repo,
  repos.pinned_spec_version       AS repo_pin,
  MAX(CASE WHEN t.kind = 'implements' THEN 1 ELSE 0 END) AS implemented,
  MAX(CASE WHEN t.kind = 'verifies'   THEN 1 ELSE 0 END) AS verified,
  GROUP_CONCAT(DISTINCT t.level)  AS test_levels
FROM requirements r
CROSS JOIN repos
LEFT JOIN tags t
  ON t.req_id = r.id AND t.repo = repos.name
-- TERM-01 (Phase 6): a glossary TERM is a requirement row but NEVER a
-- code-coverage obligation — it carries no @spec tag. Excluding key='TERM' here
-- drops terms from spec map / spec report (and provenance_matrix, which joins
-- coverage) in ONE edit, so a migrated term never renders an empty coverage
-- cell. The Q4 ORPHAN_REQ / Q5 UNVERIFIED_REQ queries (sqlite.ts) carry the
-- SAME literal exclusion so a term never fires a coverage ERROR. The match is
-- the exact literal 'TERM' — never a real domain key.
WHERE r.key != 'TERM'
GROUP BY r.id, repos.name;

CREATE VIEW IF NOT EXISTS drift AS
SELECT
  t.repo                       AS repo,
  t.req_id                     AS req_id,
  t.file                       AS source_file,
  t.line                       AS line,
  r.key                        AS domain_key,
  r.changed_at_version         AS req_changed_at_version,
  repos.pinned_spec_version    AS repo_pin
FROM tags t
JOIN requirements r ON r.id = t.req_id
JOIN repos        ON repos.name = t.repo
WHERE r.changed_at_version > repos.pinned_spec_version;

-- term_drift (TERM-01 / Phase 6): the citation-drift VIEW, a 1:1 shape-clone of
-- the member-pin drift VIEW but keyed on the CITATION's pin instead of a repo's.
-- One row per cites reference whose pinned_version is behind the cited TERM's
-- changed_at_version — i.e. the term's definition moved on since the citation
-- was pinned. INNER JOIN (not LEFT): an unresolved term_id (no matching
-- requirement) is an UNDEFINED_TERM concern, NOT drift — scoped distinctly by
-- the Wave-D diagnostics. term.key='TERM' keeps the VIEW scoped to the reserved
-- glossary domain. Present-and-empty until Wave C populates term_citations; the
-- diagnostic (TERM_DRIFT) reads it in Wave E.
-- @spec CHCK-005
CREATE VIEW IF NOT EXISTS term_drift AS
SELECT
  tc.req_id                  AS req_id,
  tc.term_id                 AS term_id,
  tc.source_file             AS source_file,
  tc.line                    AS line,
  term.changed_at_version    AS term_changed_at,
  tc.pinned_version          AS pinned
FROM term_citations tc
JOIN requirements term ON term.id = tc.term_id
WHERE term.key = 'TERM' AND term.changed_at_version > tc.pinned_version;

-- provenance_matrix (PMAT-04 / data half of PMAT-01): a WIDENED projection
-- over provenance × requirements × coverage, never materialized (mirrors the
-- coverage VIEW pattern). The widening joins are ON req_id ONLY — NEVER on
-- issue_id, which is OPAQUE (PROV-02/SC3). JOIN requirements r ON p.req_id =
-- r.id carries req_status (the requirement's lifecycle status); LEFT JOIN
-- coverage c ON c.req_id = p.req_id carries the backing-test columns. Because
-- coverage is a per-(req,repo) matrix, the join fans out per repo — so we
-- aggregate to ONE row per provenance link.
--
-- WR-01 (13-REVIEW review-fix): test_levels is re-aggregated at the
-- INDIVIDUAL-level granularity via a correlated subquery over tags, NOT by
-- GROUP_CONCAT(DISTINCT c.test_levels). The coverage VIEW already concatenates
-- levels per (req,repo) into a single string (api -> "unit,integration",
-- mobile -> "unit"); GROUP_CONCAT(DISTINCT ...) over those whole strings
-- deduplicates STRINGS, not levels, so a level present in two repos emitted
-- twice ("unit,integration,unit"). The subquery selects DISTINCT t2.level for
-- this req across ALL repos (ORDER BY level for determinism), so each level
-- appears exactly once. The correlation is ON req_id ONLY (t2.req_id =
-- p.req_id) — the issue_id-opacity fence stays green (no issue_id key usage).
-- CRITICAL FENCE CONSTRAINT
-- (PROV-02/SC3): the CI issue_id-opacity fence forbids grouping by issue_id,
-- so we GROUP BY the provenance PK p.id (which uniquely determines the link)
-- and let issue_id ride as a bare projected column under SQLite's
-- bare-column rule. issue_id is therefore PURELY projected — never a
-- JOIN/GROUP-BY/PK/FK/UNIQUE/INDEX key.
CREATE VIEW IF NOT EXISTS provenance_matrix AS
SELECT
  p.req_id                          AS req_id,
  p.role                            AS role,
  p.issue_id                        AS issue_id,   -- OPAQUE payload, projected only (PROV-02/SC3)
  p.source_file                     AS source_file,
  p.line                            AS line,        -- git pointer per PMAT-01
  r.status                          AS req_status,
  MAX(c.implemented)                AS implemented,
  MAX(c.verified)                   AS verified,
  (
    SELECT GROUP_CONCAT(lvl, ',') FROM (
      SELECT DISTINCT t2.level AS lvl
      FROM tags t2
      WHERE t2.req_id = p.req_id AND t2.level IS NOT NULL
      ORDER BY t2.level
    )
  )                                 AS test_levels
FROM provenance p
JOIN requirements r ON p.req_id = r.id
LEFT JOIN coverage c ON c.req_id = p.req_id
GROUP BY p.id;
`;

// --- TRIGGERS_DDL --------------------------------------------------------
// External-content FTS5 sync triggers. Patterns per SQLite FTS5 docs.

const TRIGGERS_DDL = `
CREATE TRIGGER IF NOT EXISTS requirements_ai AFTER INSERT ON requirements BEGIN
  INSERT INTO requirements_fts(rowid, text, why)
  VALUES (new.rowid, new.text, new.why);
END;

CREATE TRIGGER IF NOT EXISTS requirements_ad AFTER DELETE ON requirements BEGIN
  INSERT INTO requirements_fts(requirements_fts, rowid, text, why)
  VALUES ('delete', old.rowid, old.text, old.why);
END;

CREATE TRIGGER IF NOT EXISTS requirements_au AFTER UPDATE ON requirements BEGIN
  INSERT INTO requirements_fts(requirements_fts, rowid, text, why)
  VALUES ('delete', old.rowid, old.text, old.why);
  INSERT INTO requirements_fts(rowid, text, why)
  VALUES (new.rowid, new.text, new.why);
END;
`;

export const DDL = [TABLES_DDL, FTS_DDL, VIEWS_DDL, TRIGGERS_DDL].join("\n");
