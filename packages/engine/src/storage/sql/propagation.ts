// packages/engine/src/storage/sql/propagation.ts
//
// The propagation classifier: a recursive CTE walks the predecessor chain
// backwards from the target (depth-capped as a cycle guard) and classifies
// every member repo except the canonical one. The drift predicate is NOT here:
// the `drift` VIEW in @spec-engine/shared is its single home, and the storage
// layer overlays it onto these rows.
//
// Rows come out in dependency order, providers before consumers, ties by name.
// @spec PROP-006

export const PROP_REPO_STATES_SQL = `
WITH RECURSIVE ancestors(id, depth) AS (
  SELECT id, 1 FROM requirements WHERE superseded_by = $target
  UNION ALL
  SELECT r.id, a.depth + 1
  FROM requirements r
  JOIN ancestors a ON r.superseded_by = a.id
  WHERE a.depth < 16
),
target_domain(key) AS (SELECT key FROM requirements WHERE id = $target)
SELECT
  repos.name AS repo,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM tags t
      WHERE t.repo = repos.name AND t.req_id = $target AND t.kind = 'verifies'
    )
      THEN 'MIGRATED_VERIFIED'
    WHEN EXISTS (
      SELECT 1 FROM tags t
      WHERE t.repo = repos.name AND t.req_id = $target
        AND t.kind != 'documents'
    )
      THEN 'MIGRATED_UNVERIFIED'
    WHEN EXISTS (
      SELECT 1 FROM tags t
      WHERE t.repo = repos.name AND t.req_id IN (SELECT id FROM ancestors)
        AND t.kind != 'documents'
    )
      THEN 'ON_PREDECESSOR'
    WHEN EXISTS (
      SELECT 1 FROM tags t
      JOIN requirements r ON r.id = t.req_id
      WHERE t.repo = repos.name
        AND r.key = (SELECT key FROM target_domain)
        AND r.id != $target
        AND r.id NOT IN (SELECT id FROM ancestors)
        AND t.kind != 'documents'
    )
      THEN 'ON_OTHER_DOMAIN_REQ'
    ELSE 'NO_DOMAIN_REFERENCE'
  END AS state,
  (
    SELECT t.req_id FROM tags t
    WHERE t.repo = repos.name AND t.req_id IN (SELECT id FROM ancestors)
      AND t.kind != 'documents'
    LIMIT 1
  ) AS via_pred,
  (
    SELECT t.req_id FROM tags t
    JOIN requirements r ON r.id = t.req_id
    WHERE t.repo = repos.name
      AND r.key = (SELECT key FROM target_domain)
      AND r.id != $target
      AND r.id NOT IN (SELECT id FROM ancestors)
      AND t.kind != 'documents'
    LIMIT 1
  ) AS via_other
FROM repos
WHERE repos.name != 'spec-engine'
ORDER BY repos.dependency_depth, repos.name
`;
