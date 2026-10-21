// Every ORDER BY carries the full composite key the pipeline pre-sorts by and
// computeBuildId hashes by. A narrower key leaves ties (one link authored in
// two files) in physical row order and breaks cold-rebuild identity.

export const LIST_RELATIONS_SQL =
  "SELECT from_id, to_id, source_file, line FROM relations " +
  "ORDER BY from_id, to_id, source_file, line";

// The AUTOINCREMENT ids are excluded from both the projection and the hash.
export const LIST_TERM_ALIASES_SQL =
  "SELECT term_id, name FROM term_aliases ORDER BY term_id, name";
export const LIST_TERM_CITATIONS_SQL =
  "SELECT req_id, term_id, cited_as, pinned_version, source_file, line FROM term_citations " +
  "ORDER BY req_id, term_id, cited_as, source_file, line";

// issue_id is opaque: a projected payload column, never a join key.
export const LIST_PROVENANCE_SQL =
  "SELECT req_id, issue_id, role, source_file, line FROM provenance " +
  "ORDER BY req_id, role, issue_id, source_file, line";

// The WHERE clause in PROVENANCE_BY_ISSUE_SQL sits on its own line, with no
// JOIN text, so the line-oriented issue_id-opacity fence stays green.
//
// This ORDER BY is lexicographic and best-effort only: `spec provenance
// --json` is byte-stable because renderProvenance always re-sorts with a
// numeric seq. Do not drop that re-sort on the assumption this order matches.
// LIST_PROVENANCE_SQL above differs: build_id hashes its order verbatim.
export const LIST_PROVENANCE_MATRIX_SQL =
  "SELECT req_id, role, issue_id, source_file, line, req_status, implemented, verified, test_levels FROM provenance_matrix " +
  "ORDER BY req_id, role, issue_id, source_file, line";

export const PROVENANCE_BY_ISSUE_SQL =
  "SELECT req_id, role, issue_id, source_file, line, req_status, implemented, verified, test_levels FROM provenance_matrix " +
  "WHERE issue_id = $issue " +
  "ORDER BY req_id, role, issue_id, source_file, line";

// Explicit column lists, never `SELECT *`, so a new column cannot silently
// widen a row shape.

export const LIST_REPOS_SQL =
  "SELECT name, path, pinned_spec_version, dependency_depth FROM repos ORDER BY name";
export const GET_REPO_SQL =
  "SELECT name, path, pinned_spec_version, dependency_depth FROM repos WHERE name = $name";
export const LIST_DOMAINS_SQL =
  "SELECT key, owner, schema, spec_version, source_repo FROM domains ORDER BY key";
export const GET_DOMAIN_SQL =
  "SELECT key, owner, schema, spec_version, source_repo FROM domains WHERE key = $key";

// `$x IS NULL OR col = $x` keeps one bind shape across all eight filter
// combinations. The ORDER BY matches the pipeline's insertion sort.
export const LIST_TAGS_SQL = `SELECT id, req_id, repo, file, line, kind, level FROM tags
  WHERE ($repo IS NULL OR repo = $repo)
    AND ($req_id IS NULL OR req_id = $req_id)
    AND ($file IS NULL OR file = $file)
  ORDER BY repo, file, line, req_id`;

export const REQUIREMENT_COLUMNS =
  "id, key, seq, status, superseded_by, text, why, source_file, line, spec_version, changed_at_version, superseded_at_version";

// Four discrete statements rather than a composed WHERE, so each stays
// grep-scannable.
export const LIST_REQUIREMENTS_SQL_ALL = `SELECT ${REQUIREMENT_COLUMNS} FROM requirements ORDER BY key, seq`;
export const LIST_REQUIREMENTS_SQL_BY_KEY = `SELECT ${REQUIREMENT_COLUMNS} FROM requirements WHERE key = $key ORDER BY key, seq`;
export const LIST_REQUIREMENTS_SQL_BY_STATUS = `SELECT ${REQUIREMENT_COLUMNS} FROM requirements WHERE status = $status ORDER BY key, seq`;
export const LIST_REQUIREMENTS_SQL_BY_KEY_STATUS = `SELECT ${REQUIREMENT_COLUMNS} FROM requirements WHERE key = $key AND status = $status ORDER BY key, seq`;

export const GET_REQUIREMENT_SQL = `SELECT ${REQUIREMENT_COLUMNS} FROM requirements WHERE id = $id`;
