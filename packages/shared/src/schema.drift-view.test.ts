import { expect, test } from "bun:test";
import { DDL, type DriftRow, SCHEMA_VERSION, type SemanticDiagnostic } from "./index";

test("SCHEMA_VERSION is exported as a positive integer", () => {
  expect(typeof SCHEMA_VERSION).toBe("number");
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
  expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
});

test("DDL contains the `drift` VIEW with the verbatim DRIFT predicate", () => {
  expect(DDL).toContain("CREATE VIEW IF NOT EXISTS drift");
  expect(DDL).toContain("r.changed_at_version > repos.pinned_spec_version");
  // An inner JOIN: a tag with no requirement is DANGLING_TAG, not DRIFT.
  expect(/JOIN\s+requirements\s+r\s+ON\s+r\.id\s*=\s*t\.req_id/i.test(DDL)).toBe(true);
});

test("the `coverage` VIEW is in the DDL", () => {
  expect(DDL).toContain("CREATE VIEW IF NOT EXISTS coverage AS");
});

test("DriftRow and SemanticDiagnostic types are exported from @spec-engine/shared", () => {
  // A missing field surfaces as a tsc error on these typed samples.
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
