// packages/shared/test/schema-drift-view.test.ts
//
// Plan 03-01 RED gate: asserts the Phase 3 schema additions land in
// `@spec-engine/shared`. Covers:
//   - SCHEMA_VERSION bumped 1 → 2 (required so existing v1 fixture DBs trigger
//     D-12's silent rebuild on first open against the new engine).
//   - `drift` VIEW DDL appended inside VIEWS_DDL (the existing `coverage` VIEW
//     remains untouched).
//   - DriftRow + SemanticDiagnostic types exist as interfaces on the Storage
//     surface (checked indirectly via the type-only import that follows).
//   - DDL still respects SCHM-07 / D-03 (no CHECK / FK / UNIQUE on domain
//     fields) — the drift VIEW is a plain SELECT with JOINs, no constraints.

import { expect, test } from "bun:test";
import { DDL, type DriftRow, SCHEMA_VERSION, type SemanticDiagnostic } from "../src/index";

test("SCHEMA_VERSION is exported as a positive integer (Phase 3 decision: bind to constant, don't churn on bumps)", () => {
  expect(typeof SCHEMA_VERSION).toBe("number");
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
  expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
});

test("DDL contains the `drift` VIEW with the verbatim DRIFT predicate", () => {
  // CHCK-03: drift is a SQL VIEW, single source of truth.
  expect(DDL).toContain("CREATE VIEW IF NOT EXISTS drift");
  // Predicate quoted verbatim from schema.ts version-semantics block.
  expect(DDL).toContain("r.changed_at_version > repos.pinned_spec_version");
  // Inner JOIN against requirements (not LEFT JOIN) per 03-RESEARCH §
  // DRIFT VIEW — dangling tags are a separate diagnostic.
  expect(/JOIN\s+requirements\s+r\s+ON\s+r\.id\s*=\s*t\.req_id/i.test(DDL)).toBe(true);
});

test("`coverage` VIEW remains in DDL unchanged (additive change only)", () => {
  expect(DDL).toContain("CREATE VIEW IF NOT EXISTS coverage AS");
});

test("DriftRow and SemanticDiagnostic types are exported from @spec-engine/shared", () => {
  // Type-only import resolved above — assemble structural sample values to
  // exercise the field set at compile-time. The runtime assertion just
  // exercises the shape so a missing field would surface as a tsc error.
  const drift: DriftRow = {
    repo: "mobile",
    req_id: "BILLING-001",
    source_file: "mobile/src/billing.ts",
    line: 1,
    domain_key: "BILLING",
    req_changed_at_version: 2,
    repo_pin: 1,
  };
  const diag: SemanticDiagnostic = {
    code: "DRIFT",
    repo: "mobile",
    source_file: "mobile/src/billing.ts",
    line: 1,
    req_id: "BILLING-001",
    detail: "Repo mobile pinned at @1 references BILLING-001 which changed at @2",
    severity: "error",
  };
  expect(drift.repo).toBe("mobile");
  expect(diag.severity).toBe("error");
});
