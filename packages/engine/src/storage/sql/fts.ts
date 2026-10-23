// The FTS5 table is external-content, so column values come from the joined
// `requirements` row; do not switch it to contentless.

// bm25 weights text over why (1.0, 0.5); scores are negative and smaller is
// better, so rank ascending is best first. Superseded and deprecated rows are
// excluded: their text was replaced, and bm25's preference for shorter docs
// would otherwise rank a predecessor above its successor. The TERM exclusion
// is deliberately absent: terms stay in query while schema.ts keeps them out
// of the coverage view.
//
// @spec QURY-008
// @spec QURY-009
// @spec QURY-010
const FTS_OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);
const FTS_SYNTAX = /["()*:^]/;

/** Wraps a bare word holding punctuation (`changed-since`, `v1.2`) in double
 *  quotes so FTS5 reads it as a phrase instead of operators. Quoted phrases,
 *  operators, and tokens using deliberate syntax pass through.
 *  @spec QURY-005 */
export function quoteBareWords(text: string): string {
  return text
    .split(/\s+/)
    .map((token) =>
      token === "" ||
      FTS_OPERATORS.has(token) ||
      FTS_SYNTAX.test(token) ||
      /^[\p{L}\p{N}_]+$/u.test(token)
        ? token
        : `"${token}"`,
    )
    .join(" ");
}

export const FTS_SEARCH_SQL = `SELECT r.id AS req_id, r.key AS key, r.text AS text, r.why AS why, r.source_file AS source_file, r.line AS line, bm25(requirements_fts, 1.0, 0.5) AS rank FROM requirements_fts JOIN requirements r ON r.rowid = requirements_fts.rowid WHERE requirements_fts MATCH $query AND r.status NOT IN ('Superseded', 'Deprecated') ORDER BY rank ASC LIMIT $limit`;

// Built as prefix + a `(?, ?, …)` placeholder list + suffix, so file paths
// reach SQLite only as bound parameters, never as SQL text. DISTINCT collapses
// an implementing and a verifying file that resolve to the same requirement.
// `tags.file` is platform-relative, so callers must pass platform-relative
// paths.
export const RESOLVE_BY_FILES_SQL_PREFIX =
  "SELECT DISTINCT r.id, r.key, r.seq, r.status, r.superseded_by, r.text, r.why, r.source_file, r.line, r.spec_version, r.changed_at_version, r.superseded_at_version FROM tags t JOIN requirements r ON r.id = t.req_id WHERE t.file IN (";
export const RESOLVE_BY_FILES_SQL_SUFFIX = ") ORDER BY r.key, r.seq";
