// packages/engine/src/storage/sql/reads.ts
//
// The read queries: relations, term aliases and citations, provenance, repos,
// domains, tags, and requirements. Every ORDER BY carries the full composite
// key the pipeline pre-sorts by and computeBuildId hashes by; a narrower key
// would leave ties in physical row order and break cold-rebuild identity.

// Self-review: ORDER BY carries the FULL composite key — the same key the
// pipeline pre-sorts by and computeBuildId hashes by. (from_id, to_id) alone
// left ties (one link authored in two files) in physical row order, quietly
// breaking the "deterministically ordered" contract listRelations advertises.
export const LIST_RELATIONS_SQL =
  "SELECT from_id, to_id, source_file, line FROM relations " +
  "ORDER BY from_id, to_id, source_file, line";

// FULL composite key the pipeline pre-sorts by AND the computeBuildId section
// hashes by — a mismatch would silently break cold-rebuild identity (the
// relations/provenance precedent). term_aliases.id / term_citations.id
// (AUTOINCREMENT) are excluded from both the projection and the hash.
export const LIST_TERM_ALIASES_SQL =
  "SELECT term_id, name FROM term_aliases ORDER BY term_id, name";
export const LIST_TERM_CITATIONS_SQL =
  "SELECT req_id, term_id, cited_as, pinned_version, source_file, line FROM term_citations " +
  "ORDER BY req_id, term_id, cited_as, source_file, line";

// PROV-01/03/06: full composite ORDER BY for deterministic output. The column
// order (req_id, role, issue_id, source_file, line) MUST byte-match the
// pipeline.ts sortedProvenance pre-sort key AND the computeBuildId provenance
// ORDER BY below — a mismatch silently breaks cold-rebuild identity (SC4).
// issue_id is OPAQUE: it is a plain projected payload column, never a join key.
export const LIST_PROVENANCE_SQL =
  "SELECT req_id, issue_id, role, source_file, line FROM provenance " +
  "ORDER BY req_id, role, issue_id, source_file, line";

// PMAT-01/04: the widened provenance × coverage projection. Reads the
// provenance_matrix VIEW (schema.ts) — issue_id is a projected payload column,
// never a key. The WHERE clause in PROVENANCE_BY_ISSUE_SQL is kept on its OWN
// line (no JOIN text on it) so the line-oriented issue_id-opacity fence stays
// green.
//
// owned by the formatter's `sortProvenance` (provenance/format.ts), which
// orders req_id via `compareReqIds` — NUMERIC seq (BILLING-9 before BILLING-10).
// This SQL `ORDER BY req_id, ...` uses SQLite's default lexicographic text
// collation, so it is a BEST-EFFORT stable order only and is NOT byte-equal to
// the rendered order for multi-digit sequence numbers (SQL yields BILLING-10
// before BILLING-9; the formatter yields the reverse). Byte-stability of
// `spec provenance --json` is guaranteed by `renderProvenance` ALWAYS
// re-sorting, NOT by this SQL order — do NOT "optimize away" the formatter
// re-sort on the assumption that the SQL order already matches (it doesn't once
// a domain reaches a two-digit requirement count). NOTE: this is distinct from
// LIST_PROVENANCE_SQL above, whose lexicographic SQL order IS load-bearing
// because the build_id hash consumes it verbatim with no formatter re-sort.
export const LIST_PROVENANCE_MATRIX_SQL =
  "SELECT req_id, role, issue_id, source_file, line, req_status, implemented, verified, test_levels FROM provenance_matrix " +
  "ORDER BY req_id, role, issue_id, source_file, line";

export const PROVENANCE_BY_ISSUE_SQL =
  "SELECT req_id, role, issue_id, source_file, line, req_status, implemented, verified, test_levels FROM provenance_matrix " +
  "WHERE issue_id = $issue " +
  "ORDER BY req_id, role, issue_id, source_file, line";

//
// + `/api/requirements/:id` HTTP routes (server/api.ts) that depend on these
// three reads, so they're promoted to real prepared SELECTs here.
//
// D-08 keeps SQL in this file. Constants live module-scoped alongside Q1..Q5 /
// PROP_REPO_STATES_SQL / FTS_SEARCH_SQL / RESOLVE_BY_FILES_SQL_*. Each is a
// complete self-contained SELECT with explicit column projection (no `SELECT *`
// so a future column addition cannot silently widen the row shape) and an
// explicit ORDER BY for deterministic output.
//
// `listRequirements` is the only one with an optional filter shape. Per the
// plan's "easier to test/grep; perf irrelevant at PoC scale" decision, we
// model the four (key?, status?) cases as four discrete const strings rather
// than dynamically composing the WHERE clause — every SQL statement stays
// grep-scannable, and the bind keys are always the same `{key, status}` shape.

export const LIST_REPOS_SQL = "SELECT name, path, pinned_spec_version FROM repos ORDER BY name";
export const GET_REPO_SQL = "SELECT name, path, pinned_spec_version FROM repos WHERE name = $name";
export const LIST_DOMAINS_SQL =
  "SELECT key, owner, schema, spec_version, source_repo FROM domains ORDER BY key";
export const GET_DOMAIN_SQL =
  "SELECT key, owner, schema, spec_version, source_repo FROM domains WHERE key = $key";

// T7: real listTags (the Phase-1 stub returned [] forever). One statement,
// NULL-tolerant filters — `$x IS NULL OR col = $x` keeps the bind shape
// constant across all filter combinations (the discrete-constant pattern
// above would need 8 variants for three optional filters). ORDER BY matches
// the pipeline's deterministic insertion sort (repo, file, line, req_id).
export const LIST_TAGS_SQL = `SELECT id, req_id, repo, file, line, kind, level FROM tags
  WHERE ($repo IS NULL OR repo = $repo)
    AND ($req_id IS NULL OR req_id = $req_id)
    AND ($file IS NULL OR file = $file)
  ORDER BY repo, file, line, req_id`;

export const REQUIREMENT_COLUMNS =
  "id, key, seq, status, superseded_by, text, why, source_file, line, spec_version, changed_at_version, superseded_at_version";

export const LIST_REQUIREMENTS_SQL_ALL = `SELECT ${REQUIREMENT_COLUMNS} FROM requirements ORDER BY key, seq`;
export const LIST_REQUIREMENTS_SQL_BY_KEY = `SELECT ${REQUIREMENT_COLUMNS} FROM requirements WHERE key = $key ORDER BY key, seq`;
export const LIST_REQUIREMENTS_SQL_BY_STATUS = `SELECT ${REQUIREMENT_COLUMNS} FROM requirements WHERE status = $status ORDER BY key, seq`;
export const LIST_REQUIREMENTS_SQL_BY_KEY_STATUS = `SELECT ${REQUIREMENT_COLUMNS} FROM requirements WHERE key = $key AND status = $status ORDER BY key, seq`;

export const GET_REQUIREMENT_SQL = `SELECT ${REQUIREMENT_COLUMNS} FROM requirements WHERE id = $id`;
