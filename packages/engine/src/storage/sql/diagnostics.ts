// packages/engine/src/storage/sql/diagnostics.ts
//
// The semantic diagnostic queries behind `spec check`. Every SELECT yields the
// same row shape `{ code, repo, source_file, line, req_id, detail, severity }`
// with an explicit ORDER BY, so the storage layer concatenates them as-is and
// the output stays deterministic.

//
// The five semantic diagnostic queries are the SQL surface for `spec check`.
// Each emits a uniform row shape `{code, repo, source_file, line, req_id,
// detail, severity}` so listSemanticDiagnostics can concatenate without
// reshaping. Source of truth: 03-RESEARCH § Diagnostic SQL.
//
// D-08 keeps SQL in this file. Constants live module-scoped (above the class)
// for readability; each is a complete self-contained SELECT with explicit
// ORDER BY for deterministic output.

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

// The Q2 analogue for the other terminal status: a tag on a Deprecated
// requirement is code claiming a dead promise. Error severity, same shape.
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

// The Draft blind spot (drift audit, statement 6): code shipped against a
// promise nobody approved yet. Warning — a review prompt, not a break.
// @spec CHCK-009
export const Q2D_DRAFT_REFERENCED_SQL = `
SELECT
  'DRAFT_REFERENCED'                                          AS code,
  t.repo                                                      AS repo,
  t.file                                                      AS source_file,
  t.line                                                      AS line,
  t.req_id                                                    AS req_id,
  ('Tag references Draft requirement ' || t.req_id ||
    ' — code is bound to a promise nobody approved yet')      AS detail,
  'warning'                                                   AS severity
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
  -- code-coverage obligation — exclude the reserved TERM domain so a migrated
  -- term never fires ORPHAN_REQ. Literal 'TERM' only, never a real domain key;
  -- mirrors the coverage VIEW exclusion (WHERE r.key != 'TERM') in schema.ts.
  -- @spec SCHM-017
  AND r.key != 'TERM'
  AND NOT EXISTS (
    SELECT 1 FROM tags t WHERE t.req_id = r.id AND t.kind != 'documents'
  )
ORDER BY r.key, r.seq
`;
// ^ RED-15: documents-kind tags (doc bindings) must NOT suppress ORPHAN_REQ —
//   a guide paragraph citing a requirement is not an implementation. Only
//   code-derived kinds (implements/verifies) clear orphan status.

export const Q5_UNVERIFIED_REQ_SQL = `
SELECT
  'UNVERIFIED_REQ'                                            AS code,
  NULL                                                        AS repo,
  r.source_file                                               AS source_file,
  r.line                                                      AS line,
  r.id                                                        AS req_id,
  ('Requirement ' || r.id ||
    ' is implemented but has no verifies-kind tag')           AS detail,
  'error'                                                     AS severity
FROM requirements r
WHERE r.status = 'Active'
  -- never implemented/verified by code, so it must never fire UNVERIFIED_REQ.
  -- Literal 'TERM' only; mirrors Q4 + the coverage VIEW exclusion.
  AND r.key != 'TERM'
  AND EXISTS (SELECT 1 FROM tags t WHERE t.req_id = r.id AND t.kind = 'implements')
  AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.req_id = r.id AND t.kind = 'verifies')
ORDER BY r.key, r.seq
`;

// --- Relates diagnostics (Q6/Q7) -----------------------------------
//
// Both WARNING severity: relations are advisory links, not load-bearing
// supersession chains. req_id is the FROM side (the requirement whose
// authored Relates line needs attention); source_file/line locate that line.

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

//
// Q8/Q9 are the two term-store semantic diagnostics, appended to the Q1..Q7
// union in listSemanticDiagnostics. Both emit the uniform SemanticDiagnostic
// column shape (code, repo, source_file, line, req_id, detail, severity) so the
// union concatenates without reshaping. Dogfooded as a CHCK requirement.
//
// UNDEFINED_TERM (error) mirrors BROKEN_RELATES (Q6): a LEFT JOIN from the
// citation to its resolved term, firing when nothing on the right matches —
// but ERROR severity (like DANGLING_TAG), because a requirement citing a term
// no glossary defines is a real defect that must gate `--ci`. The predicate is
// `tc.term_id IS NULL OR term.id IS NULL`: the pipeline already resolves a
// citation to `term_id = NULL` when unresolvable (Invariant #4), so the first
// clause catches the common case; the LEFT JOIN's second clause is defense in
// depth against a term_id that points at a non-TERM / deleted row. repo is NULL
// (the defect is in the SPEC's cites field, not a member repo).
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

// ORPHAN_TERM (warning) mirrors ORPHAN_REQ (Q4): a NOT EXISTS over the coverage
// edge — but the edge is `term_citations` (an inbound citation), not `tags` (an
// implementing tag), scoped to the reserved TERM domain. WARNING severity is
// LOAD-BEARING: a freshly-migrated/minted term legitimately has no citations
// yet, and Wave F migrates ~30 GLOSSARY.md terms at once — an error here would
// terms (a Draft/Retired term is not a live obligation). ORDER BY (key, seq)
// matches Q4/Q5.
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

//
// Q10/Q11 are the two citation-drift diagnostics — the member-pin DRIFT/
// SUPERSEDED_REFERENCED pair replayed ONE LEVEL UP (req -> term). Appended to
// the Q1..Q9 union in listSemanticDiagnostics; both emit the uniform
// SemanticDiagnostic column shape so the union concatenates without reshaping.
// Dogfooded as a CHCK requirement.
//
// TERM_DRIFT (warning) SELECTs the `term_drift` VIEW (schema.ts) — the drift
// predicate `term.changed_at_version > citation.pinned` lives in ONE place, a
// 1:1 shape-clone of the member-pin `drift` VIEW that Q3 DRIFT reads (CHCK-03:
// one predicate, one place; T-06-14). Q10 NEVER re-spells the comparison — it
// just reads the VIEW, exactly as Q3 reads `drift`. WARNING severity (a lagging
// pin is a re-confirmation prompt, not a build-breaker), so a drifted citation
// keeps `spec check --ci` at exit 0. repo is NULL (the pin lives in the SPEC's
// cites field, not a member repo).
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

// SUPERSEDED_TERM_REFERENCED (error) clones Q2 SUPERSEDED_REFERENCED one level
// up: a `term_citations` row (a citation is a requirement's "tag" onto a term)
// JOINed to the cited term WHERE the term is Superseded. ERROR severity (like
// Q2), so it flips `spec check --ci` to exit 1 via the unchanged
// `severity === 'error'` predicate. term.key='TERM' keeps it scoped to the
// reserved glossary domain; detail names the successor (superseded_by). repo is
// NULL (the stale citation is in the SPEC's cites field, not a member repo).
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
