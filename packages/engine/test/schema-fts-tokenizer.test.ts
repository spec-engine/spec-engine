// packages/engine/test/schema-fts-tokenizer.test.ts
// Locks: QURY-02 ("renewal charge" → BILLING-009 via porter stemming) +
// Pitfall 4 regression guard (external-content FTS5 mode must not regress
// to contentless, which would NULL out text/why on query results).

import { describe, expect, test } from "bun:test";
import { DDL, SCHEMA_VERSION } from "@spec-engine/shared";

describe("schema FTS tokenizer", () => {
  test("SCHEMA_VERSION reflects the latest schema change (10: requirements.superseded_at_version column — the immutable envelope version a requirement was superseded/retired at)", () => {
    // History: 4 = FTS porter tokenizer (plan 04-01); 5 = `relations`
    // table for the Relates field (RED-16); 6 = `provenance` table +
    // `provenance_matrix` VIEW for the `**Issues:**` field (Phase 12 PROV);
    // 7 = widened `provenance_matrix` VIEW (provenance × requirements ×
    // coverage join, req_status + backing-test columns) for the Phase 13
    // PMAT surface; 8 = corrected `provenance_matrix.test_levels` aggregation
    // (correlated subquery over `tags` at individual-level granularity instead
    // of GROUP_CONCAT(DISTINCT c.test_levels), which double-counted a level
    // present in multiple repos) — Phase 13 WR-01 review-fix; 9 = the TERM-store
    // substrate (Phase 6): the `term_aliases` + `term_citations` derived tables
    // (cloned from `relations`), the `term_drift` VIEW, and the coverage VIEW's
    // `WHERE r.key != 'TERM'` exclusion (a glossary term is a requirement row
    // but never a code-coverage obligation); 10 = the
    // `requirements.superseded_at_version` column — the envelope version a
    // requirement was superseded/retired at, authored once by
    // `spec supersede`/`spec move` and never recomputed (unlike
    // changed_at_version), so a lineage can show the true "died at vN".
    // Bump this expectation with every deliberate schema change — its job is
    // to force the committer to ACKNOWLEDGE that every on-disk DB will take
    // the D-12 silent rebuild on upgrade.
    expect(SCHEMA_VERSION).toBe(10);
  });

  test("FTS_DDL uses porter unicode61 tokenizer and preserves external-content mode", () => {
    expect(DDL).toContain("tokenize='porter unicode61'");
    // Pitfall 4 regression guard: external-content FTS5 mode must remain
    // (contentless would return NULL for text/why on query results).
    expect(DDL).toContain("content='requirements'");
  });
});
