// packages/engine/src/storage/sql/fts.ts
//
// Full-text search and the files-to-requirements join. The FTS5 table is
// external-content, so column values come from the joined `requirements`
// row; do not switch it to contentless. Superseded and deprecated rows are
// excluded from search because their text was replaced. `resolveByFiles` is
// built as prefix + a bound placeholder list + suffix so inputs never reach
// the SQL as text.

//
// D-08 keeps this SQL in this file alongside Q1..Q5 and PROP_REPO_STATES_SQL.
// External-content FTS5 over `requirements` with the `porter unicode61`
// renewed` to the stem `renew`, which is exactly what makes QURY-02
// (`spec query "renewal charge"` returns BILLING-009 against the canonical
// fixture, whose text contains `renews` not `renewal`) work.
//
// The bm25 column weights are tuned `(text=1.0, why=0.5)` — primary content
// outranks context. SQLite's bm25 returns NEGATIVE scores where smaller
// (more negative) = better; sorting rank ascending puts the best hit first.
//
// User input flows through the `$query` bind (never concatenated); FTS5
// grammar errors are surfaced via the try/catch in `searchFts` (04-RESEARCH
// index, so column values come from the JOINed `requirements` base table via

// Note on `r.status != 'Superseded'`: a superseded requirement is, by
// definition, no longer the live answer to a query — its text was replaced.
// Including it in FTS results would surface stale guidance (and, against the
// canonical fixture, would rank BILLING-001's shorter text ABOVE BILLING-009
// for "renewal charge" because bm25 favors shorter docs at equal term
// frequency). The filter mirrors Q5 / Q4 status checks elsewhere in this
// file and keeps QURY-02's empirical proof of porter stemming honest.
//
// formatter can split a Terms group from a Requirements group — terms ARE
// requirement rows (reserved TERM domain) that ride this same FTS index via
// their `statement` → `text` column. The `key != 'TERM'` coverage exclusion is
// DELIBERATELY NOT applied here: terms must stay IN query while OUT of coverage
// (schema.ts owns that exclusion on the coverage VIEW). Widening the projection
// with `key` cannot change cold-build identity — searchFts output is not hashed
// into build_id.
//
// @spec QURY-008
// @spec QURY-009
// @spec QURY-006
// @spec QURY-004
export const FTS_SEARCH_SQL = `SELECT r.id AS req_id, r.key AS key, r.text AS text, r.why AS why, r.source_file AS source_file, r.line AS line, bm25(requirements_fts, 1.0, 0.5) AS rank FROM requirements_fts JOIN requirements r ON r.rowid = requirements_fts.rowid WHERE requirements_fts MATCH $query AND r.status NOT IN ('Superseded', 'Deprecated') ORDER BY rank ASC LIMIT $limit`;

//
// D-08 keeps SQL in this file. `resolveByFiles` is the storage seam every
// `/api/resolve` HTTP route in 05-03). The contract: given a list of
// platform-relative file paths, return the requirements that any tag in any
// of those files points at, deduped by id and ordered deterministically.
//
// The SQL is built as PREFIX + dynamic `(?, ?, ...)` placeholder string +
// SUFFIX so the same prepared statement shape is used for every call (a
// single non-cached query is fine at PoC scope; v2 may LRU-cache by
// `files.length`). Inputs flow through SQLite bind parameters via the
// `.all(...files)` spread — never string concatenated (T-5-01-01).
//
// DISTINCT collapses the case where a single file's tag plus another file's
// tag both resolve to the same requirement (e.g. `api/src/renew.ts` carries
// the `implements` tag for BILLING-009 and `api/test/renew.e2e.test.ts`
// carries the `verifies` tag for the same id; passing both files would
// otherwise produce two join rows for one Requirement).
//
// ORDER BY r.key, r.seq gives stable, caller-independent ordering matched
// `tags.file` column is stored platform-relative; callers must therefore
// pass platform-relative paths, never absolute or repo-relative.
export const RESOLVE_BY_FILES_SQL_PREFIX =
  "SELECT DISTINCT r.id, r.key, r.seq, r.status, r.superseded_by, r.text, r.why, r.source_file, r.line, r.spec_version, r.changed_at_version, r.superseded_at_version FROM tags t JOIN requirements r ON r.id = t.req_id WHERE t.file IN (";
export const RESOLVE_BY_FILES_SQL_SUFFIX = ") ORDER BY r.key, r.seq";
