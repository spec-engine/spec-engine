// packages/shared/src/schema.ts
//
// @spec SCHM-011
// @spec PROP-004
//
// The derived index's schema vocabulary: SCHEMA_VERSION and the DDL, inline TS
// strings, no .sql files.
//
// Version columns:
//
//   domains.spec_version          The domain's current version (the SPEC.json
//                                 envelope's `specVersion`).
//
//   requirements.spec_version     The domain version at which this requirement was
//                                 last introduced or reaffirmed.
//
//   requirements.changed_at_version  The domain version of the last semantically
//                                 meaningful change to this requirement (supersede,
//                                 amend, status change). For a superseded entry the
//                                 index forces this to the current envelope version,
//                                 so it drifts upward on every later bump; read
//                                 superseded_at_version for the version it died at.
//
//   requirements.superseded_at_version  The envelope version at the moment this
//                                 requirement was superseded, authored once by
//                                 `spec supersede` / `spec move` and never recomputed.
//                                 NULL for Active entries and for supersessions that
//                                 predate the field.
//
//   repos.pinned_spec_version     The member's declared pin (`specs: "spec-engine@N"`
//                                 in its spec-engine.member.json).
//
//   repos.dependency_depth        The member's position in the platform map's
//                                 dependsOn graph: 0 with no in-platform dependency,
//                                 else one more than its deepest dependency.
//
// Drift predicate (the `drift` VIEW, its only home):
//   r.changed_at_version > repos.pinned_spec_version  AND  tags(repo, req_id) exists.
//   A repo is drifted only for requirements it actually references.

// Any change to the DDL bumps this number. A DB whose stored version differs is
// wiped and rebuilt on open; the index is derived, so no migration exists.
// @spec SCHM-016
export const SCHEMA_VERSION = 11;

/**
 * Upper bound on the number of file inputs accepted by `spec resolve`,
 * `/api/resolve`, and the storage seam (`resolveByFiles`). Sized well below
 * SQLITE_MAX_VARIABLE_NUMBER (32766 in Bun's bundled SQLite) so the IN-clause
 * spread cannot exceed the bind-parameter ceiling.
 */
export const FILES_MAX = 1000;

/**
 * Query-result bounds shared by the CLI (`spec query --limit`), the MCP
 * `spec_query` tool, and the HTTP `?limit=` param. The ceiling is also a DoS
 * bound.
 */
export const DEFAULT_QUERY_LIMIT = 10;
export const LIMIT_MAX = 1000;

// --- TABLES_DDL ----------------------------------------------------------

const TABLES_DDL = `
-- _schema_version: single-row table holding the integer schema_version on disk.
-- Engine reads this on open; if it doesn't match SCHEMA_VERSION, the DB is wiped
-- and rebuilt from scratch.
CREATE TABLE IF NOT EXISTS _schema_version (
  version INTEGER NOT NULL
);

-- No CHECK, FK, or UNIQUE constraint on any domain field. PRIMARY KEY only.
CREATE TABLE IF NOT EXISTS repos (
  name                  TEXT PRIMARY KEY,
  path                  TEXT NOT NULL,
  pinned_spec_version   INTEGER NOT NULL,
  dependency_depth      INTEGER NOT NULL
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

-- relations: one row per relates link. from_id carries the field; to_id is
-- the linked requirement. No FK: a to_id pointing at a missing requirement
-- lands verbatim so spec check can surface BROKEN_RELATES; a to_id whose
-- requirement was superseded surfaces RELATES_SUPERSEDED.
CREATE TABLE IF NOT EXISTS relations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  source_file   TEXT NOT NULL,
  line          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id);
CREATE INDEX IF NOT EXISTS idx_relations_to   ON relations(to_id);

-- term_aliases: one row per glossary-term alias. id AUTOINCREMENT is excluded
-- from build_id. term_id is the owning TERM's id; name the synonym string.
CREATE TABLE IF NOT EXISTS term_aliases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id       TEXT NOT NULL,
  name          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_term_aliases_term ON term_aliases(term_id);
CREATE INDEX IF NOT EXISTS idx_term_aliases_name ON term_aliases(name);

-- term_citations: one row per pinned cites reference from a requirement to a
-- glossary TERM. id AUTOINCREMENT is excluded from build_id. No FK: a term_id
-- pointing at a missing or superseded TERM lands verbatim so spec check can
-- surface UNDEFINED_TERM / TERM_DRIFT. term_id is nullable (an unresolved cite
-- still lands); cited_as is the authored surface form; pinned_version the term
-- spec_version the citation was pinned to.
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

-- provenance: one row per issues role:ID link. issue_id is the opaque
-- external tracker payload; role is a closed-allow-list label (created |
-- supersedes-via | amends-via), validated at parse time, never as a DB
-- constraint. Exactly one index, on req_id; never on issue_id, which would
-- treat the opaque payload as a lookup key.
-- @spec PROV-004
CREATE TABLE IF NOT EXISTS provenance (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id        TEXT NOT NULL,
  issue_id      TEXT NOT NULL,   -- opaque payload string, never a PK/FK/UNIQUE/JOIN key
  role          TEXT NOT NULL,   -- created | supersedes-via | amends-via
  source_file   TEXT NOT NULL,
  line          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provenance_by_req ON provenance(req_id);  -- the only index

-- parse_diagnostics: structural diagnostics from the validate-on-parse pass
-- (DUP_ID, BROKEN_SUPERSEDE, BAD_STATUS), stored so spec check can render them
-- with file+line. req_id is NULL when no specific id is implicated.
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
// External-content FTS5 over requirements.text + requirements.why.
// content_rowid='rowid' uses SQLite's implicit INTEGER rowid (requirements.id
// is TEXT). The triggers below keep FTS in sync inside the write transaction.

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
// coverage and drift are VIEWs, never materialized. CROSS JOIN repos LEFT JOIN
// tags produces the requirement × repo matrix. The drift predicate lives only
// here; INNER JOIN against requirements, because a tag without a matching
// requirement is a DANGLING_TAG, not a DRIFT.

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
-- A glossary TERM is a requirement row but never a code-coverage obligation.
-- The ORPHAN_REQ / UNVERIFIED_REQ queries in sqlite.ts carry the same literal
-- exclusion. The match is the exact literal 'TERM', never a real domain key.
-- @spec SCHM-017
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

-- term_drift: one row per cites reference whose pinned_version is behind the
-- cited TERM's changed_at_version. INNER JOIN: an unresolved term_id is an
-- UNDEFINED_TERM concern, not drift.
-- @spec CHCK-018
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

-- provenance_matrix: provenance × requirements × coverage, never
-- materialized. Every join is on req_id, never on issue_id. coverage is a
-- per-(req, repo) matrix, so the join fans out per repo and is aggregated to
-- one row per provenance link, grouped by the provenance PK p.id; issue_id
-- rides as a bare projected column and is never a JOIN, GROUP BY, PK, FK,
-- UNIQUE, or INDEX key. test_levels is aggregated by a correlated subquery
-- over tags (DISTINCT level, ORDER BY level) so a level present in two repos
-- appears once.
CREATE VIEW IF NOT EXISTS provenance_matrix AS
SELECT
  p.req_id                          AS req_id,
  p.role                            AS role,
  p.issue_id                        AS issue_id,   -- opaque payload, projected only
  p.source_file                     AS source_file,
  p.line                            AS line,
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
// External-content FTS5 sync triggers, the patterns from the SQLite FTS5 docs.

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
