// packages/shared/test/report.test.ts
//
// Webapp coverage report (W1) — buildCoverageReport rolls the (req × repo)
// coverage matrix up into one row per domain over ACTIVE requirements:
//   active       — count of Active requirements in the domain
//   implemented  — Active reqs with an implementing tag in ANY repo
//   verified     — Active reqs with a verifying tag in ANY repo
//   orphans      — Active reqs with no implementing tag anywhere
//   unverified   — implemented but not verified
// Pure function over CoverageRow[] (the /api/coverage shape) so the engine
// API, the webapp, and any future CLI report command share one rollup.

import { describe, expect, test } from "bun:test";
import { buildCoverageReport } from "../src/report";
import type { CoverageRow } from "../src/storage";

function row(over: Partial<CoverageRow>): CoverageRow {
  return {
    req_id: "A-001",
    domain_key: "A",
    req_status: "Active",
    req_spec_version: 1,
    req_changed_at_version: 1,
    repo: "api",
    repo_pin: 1,
    implemented: 0,
    verified: 0,
    test_levels: null,
    ...over,
  };
}

describe("buildCoverageReport (W1)", () => {
  test("rolls up per domain: any-repo implemented/verified, orphans, unverified", () => {
    const rows: CoverageRow[] = [
      // A-001: implemented + verified in repo api; nothing in repo web.
      row({ req_id: "A-001", implemented: 1, verified: 1 }),
      row({ req_id: "A-001", repo: "web" }),
      // A-002: implemented only, in web.
      row({ req_id: "A-002" }),
      row({ req_id: "A-002", repo: "web", implemented: 1 }),
      // A-003: untouched anywhere → orphan.
      row({ req_id: "A-003" }),
      row({ req_id: "A-003", repo: "web" }),
      // B-001: verified-only coverage (test-first) — counts verified, not implemented.
      row({ req_id: "B-001", domain_key: "B", verified: 1 }),
    ];
    expect(buildCoverageReport(rows)).toEqual([
      { domain: "A", active: 3, implemented: 2, verified: 1, orphans: 1, unverified: 1 },
      { domain: "B", active: 1, implemented: 0, verified: 1, orphans: 1, unverified: 0 },
    ]);
  });

  test("non-Active requirements are excluded from every count", () => {
    const rows: CoverageRow[] = [
      row({ req_id: "A-001", req_status: "Superseded", implemented: 1, verified: 1 }),
      row({ req_id: "A-002", implemented: 1 }),
    ];
    expect(buildCoverageReport(rows)).toEqual([
      { domain: "A", active: 1, implemented: 1, verified: 0, orphans: 0, unverified: 1 },
    ]);
  });

  test("domains sort lexicographically; empty input → []", () => {
    expect(buildCoverageReport([])).toEqual([]);
    const rows: CoverageRow[] = [
      row({ req_id: "Z-001", domain_key: "Z", implemented: 1 }),
      row({ req_id: "B-001", domain_key: "B" }),
    ];
    expect(buildCoverageReport(rows).map((r) => r.domain)).toEqual(["B", "Z"]);
  });
});
