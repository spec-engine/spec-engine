// Every SELECT yields the same row shape `{ code, repo, source_file, line,
// req_id, detail, severity }` with an explicit ORDER BY, so
// listSemanticDiagnostics concatenates them without reshaping.

export const Q1_DANGLING_TAG_SQL = `
SELECT
  'DANGLING_TAG'                                              AS code,
  t.repo                                                      AS repo,
  t.file                                                      AS source_file,
  t.line                                                      AS line,
  t.req_id                                                    AS req_id,
  ('Tag references non-existent requirement ' || t.req_id)    AS detail,
  'error'                                                     AS severity
FROM tags t
LEFT JOIN requirements r ON r.id = t.req_id
WHERE r.id IS NULL
ORDER BY t.repo, t.file, t.line
`;

export const Q2_SUPERSEDED_REFERENCED_SQL = `
SELECT
  'SUPERSEDED_REFERENCED'                                     AS code,
  t.repo                                                      AS repo,
  t.file                                                      AS source_file,
  t.line                                                      AS line,
  t.req_id                                                    AS req_id,
  ('Tag references superseded requirement ' || t.req_id ||
    ' (superseded by ' || COALESCE(r.superseded_by, '?') || ')') AS detail,
  'error'                                                     AS severity
FROM tags t
JOIN requirements r ON r.id = t.req_id
WHERE r.status = 'Superseded'
ORDER BY t.repo, t.file, t.line
`;

// @spec CHCK-007
export const Q2B_DEPRECATED_REFERENCED_SQL = `
SELECT
  'DEPRECATED_REFERENCED'                                     AS code,
  t.repo                                                      AS repo,
  t.file                                                      AS source_file,
  t.line                                                      AS line,
  t.req_id                                                    AS req_id,
  ('Tag references deprecated requirement ' || t.req_id ||
    ' — it is end-of-life with no successor')                 AS detail,
  'error'                                                     AS severity
FROM tags t
JOIN requirements r ON r.id = t.req_id
WHERE r.status = 'Deprecated'
ORDER BY t.repo, t.file, t.line
`;

// @spec CHCK-033
// @spec CHCK-034
export const Q2D_DRAFT_REFERENCED_SQL = `
SELECT
  'DRAFT_REFERENCED'                                          AS code,
  t.repo                                                      AS repo,
  t.file                                                      AS source_file,
  t.line                                                      AS line,
  t.req_id                                                    AS req_id,
  CASE WHEN t.kind = 'verifies'
    THEN ('Test verifies Draft requirement ' || t.req_id ||
      ' — it asserts a promise nobody accepted yet')
    ELSE ('Tag references Draft requirement ' || t.req_id ||
      ' — code is bound to a promise nobody accepted yet')
  END                                                         AS detail,
  CASE WHEN t.kind = 'verifies' THEN 'error' ELSE 'warning' END AS severity
FROM tags t
JOIN requirements r ON r.id = t.req_id
WHERE r.status = 'Draft'
ORDER BY t.repo, t.file, t.line
`;

export const Q3_DRIFT_SQL = `
SELECT
  'DRIFT'                                                     AS code,
  d.repo                                                      AS repo,
  d.source_file                                               AS source_file,
  d.line                                                      AS line,
  d.req_id                                                    AS req_id,
  ('Repo ' || d.repo || ' pinned at @' || d.repo_pin ||
    ' references ' || d.req_id || ' which changed at @' ||
    d.req_changed_at_version)                                 AS detail,
  'error'                                                     AS severity
FROM drift d
ORDER BY d.repo, d.source_file, d.line
`;

// @spec CHCK-032
// @spec PROOF-011
export const Q4_ORPHAN_REQ_SQL = `
SELECT
  'ORPHAN_REQ'                                                AS code,
  NULL                                                        AS repo,
  r.source_file                                               AS source_file,
  r.line                                                      AS line,
  r.id                                                        AS req_id,
  ('Active requirement ' || r.id ||
    ' has no implementing tag in any member repo')          AS detail,
  'error'                                                     AS severity
FROM requirements r
WHERE r.status = 'Active'
  -- Must stay in step with the coverage view's TERM exclusion in schema.ts.
  -- @spec SCHM-017
  AND r.key != 'TERM'
  -- A doc paragraph citing a requirement is not an implementation.
  AND NOT EXISTS (
    SELECT 1 FROM tags t WHERE t.req_id = r.id AND t.kind != 'documents'
  )
ORDER BY r.key, r.seq
`;

// @spec CHCK-032
// @spec CHCK-035
export const Q5_UNVERIFIED_REQ_SQL = `
SELECT
  'UNVERIFIED_REQ'                                            AS code,
  NULL                                                        AS repo,
  r.source_file                                               AS source_file,
  r.line                                                      AS line,
  r.id                                                        AS req_id,
  ('Requirement ' || r.id ||
    ' is implemented but has no verifies-kind tag')           AS detail,
  'warning'                                                   AS severity
FROM requirements r
WHERE r.status = 'Active'
  -- Must stay in step with Q4 and the coverage view's TERM exclusion.
  AND r.key != 'TERM'
  AND EXISTS (SELECT 1 FROM tags t WHERE t.req_id = r.id AND t.kind = 'implements')
  AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.req_id = r.id AND t.kind = 'verifies')
ORDER BY r.key, r.seq
`;

// Relates diagnostics are warnings: relations are advisory links, not
// supersession chains.

export const Q6_BROKEN_RELATES_SQL = `
SELECT
  'BROKEN_RELATES'                                            AS code,
  NULL                                                        AS repo,
  rel.source_file                                             AS source_file,
  rel.line                                                    AS line,
  rel.from_id                                                 AS req_id,
  ('Relates on ' || rel.from_id ||
    ' references non-existent requirement ' || rel.to_id)     AS detail,
  'warning'                                                   AS severity
FROM relations rel
LEFT JOIN requirements r ON r.id = rel.to_id
WHERE r.id IS NULL
ORDER BY rel.source_file, rel.line, rel.from_id, rel.to_id
`;

export const Q7_RELATES_SUPERSEDED_SQL = `
SELECT
  'RELATES_SUPERSEDED'                                        AS code,
  NULL                                                        AS repo,
  rel.source_file                                             AS source_file,
  rel.line                                                    AS line,
  rel.from_id                                                 AS req_id,
  (rel.from_id || ' relates to ' || rel.to_id ||
    ' which was superseded by ' ||
    COALESCE(r.superseded_by, '?') || ' — review the relation') AS detail,
  'warning'                                                   AS severity
FROM relations rel
JOIN requirements r ON r.id = rel.to_id
WHERE r.status = 'Superseded'
ORDER BY rel.source_file, rel.line, rel.from_id, rel.to_id
`;

// The pipeline stores an unresolvable citation as `term_id = NULL`, which the
// first clause catches; the second guards a term_id pointing at a non-TERM or
// deleted row.
// @spec CHCK-016
export const Q8_UNDEFINED_TERM_SQL = `
SELECT
  'UNDEFINED_TERM'                                            AS code,
  NULL                                                        AS repo,
  tc.source_file                                              AS source_file,
  tc.line                                                     AS line,
  tc.req_id                                                   AS req_id,
  ('Statement of ' || tc.req_id ||
    ' cites undefined term ' || tc.cited_as)                  AS detail,
  'error'                                                     AS severity
FROM term_citations tc
LEFT JOIN requirements term ON term.id = tc.term_id AND term.key = 'TERM'
WHERE tc.term_id IS NULL OR term.id IS NULL
ORDER BY tc.source_file, tc.line, tc.req_id
`;

// Warning, not error, on purpose: a freshly minted or migrated term
// legitimately has no citations yet.
// @spec CHCK-017
export const Q9_ORPHAN_TERM_SQL = `
SELECT
  'ORPHAN_TERM'                                               AS code,
  NULL                                                        AS repo,
  r.source_file                                               AS source_file,
  r.line                                                      AS line,
  r.id                                                        AS req_id,
  ('Active term ' || r.id ||
    ' is defined but no requirement cites it')                AS detail,
  'warning'                                                   AS severity
FROM requirements r
WHERE r.key = 'TERM'
  AND r.status = 'Active'
  AND NOT EXISTS (
    SELECT 1 FROM term_citations tc WHERE tc.term_id = r.id
  )
ORDER BY r.key, r.seq
`;

// The drift predicate lives only in the `term_drift` view (schema.ts); never
// re-spell the comparison here. A lagging pin is a re-confirmation prompt, not
// a build-breaker, so this is a warning.
// @spec CHCK-018
export const Q10_TERM_DRIFT_SQL = `
SELECT
  'TERM_DRIFT'                                               AS code,
  NULL                                                       AS repo,
  td.source_file                                             AS source_file,
  td.line                                                    AS line,
  td.req_id                                                  AS req_id,
  ('Citation from ' || td.req_id || ' pins term ' || td.term_id ||
    ' @' || td.pinned || ' but it changed at @' || td.term_changed_at ||
    ' — re-confirm with spec term confirm')                 AS detail,
  'warning'                                                  AS severity
FROM term_drift td
ORDER BY td.source_file, td.line, td.req_id
`;

// @spec CHCK-019
export const Q11_SUPERSEDED_TERM_REFERENCED_SQL = `
SELECT
  'SUPERSEDED_TERM_REFERENCED'                               AS code,
  NULL                                                       AS repo,
  tc.source_file                                             AS source_file,
  tc.line                                                    AS line,
  tc.req_id                                                  AS req_id,
  ('Citation from ' || tc.req_id || ' references superseded term ' ||
    tc.term_id || ' (superseded by ' ||
    COALESCE(term.superseded_by, '?') || ')')                AS detail,
  'error'                                                    AS severity
FROM term_citations tc
JOIN requirements term ON term.id = tc.term_id
WHERE term.key = 'TERM' AND term.status = 'Superseded'
ORDER BY tc.source_file, tc.line, tc.req_id
`;
