// packages/engine/test/propagation.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec PROP-003
//
// Plan 04-02 / Task 2 — lock the canonical fixture trace for PROP-02 at the
// Storage seam. The 5-state classifier (PROP_REPO_STATES_SQL + propagationFor
// in storage/sqlite.ts) is the single SQL+TS surface every higher-level
// member (plan 04-04's `spec propagation` command, the webapp in Phase 5)
// reads through; if a future refactor changes the precedence ladder, the
// cycle guard, or the member-only filter, this file fails before any
// rendered output churns.
//
// Pattern mirrors check-drift-view.test.ts: mkdtempSync tmp dir,
// openStorage(dbPath), runIndex({ platformDir: FIXTURE, storage }), then
// read via storage.propagationFor(...) and assert on PropagationRow shape
// with literal PropagationState.* constants (no string smell-tests).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type PropagationRow, PropagationState, type Storage } from "@spec-engine/shared";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-propagation-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function buildFixtureStorage(): Promise<Storage> {
  const storage = openStorage(dbPath);
  await runIndex({ platformDir: FIXTURE, storage });
  return storage;
}

describe("propagationFor (PROP-02 — 5-state classifier)", () => {
  test("BILLING-009 fixture trace: api=MIGRATED_VERIFIED, mobile=ON_PREDECESSOR via BILLING-001 (drifted), admin=ON_OTHER_DOMAIN_REQ via BILLING-007", async () => {
    const storage = await buildFixtureStorage();
    try {
      const rows = storage.propagationFor("BILLING-009");

      // SQL orders by repos.name; assert exact set + order.
      expect(rows.length).toBe(3);
      expect(rows.map((r) => r.repo)).toEqual(["admin", "api", "mobile"]);

      const apiRow = rows.find((r) => r.repo === "api") as PropagationRow;
      expect(apiRow).toEqual({
        repo: "api",
        state: PropagationState.MIGRATED_VERIFIED,
        via_req_id: null,
        drifted: false,
      });

      const mobileRow = rows.find((r) => r.repo === "mobile") as PropagationRow;
      expect(mobileRow).toEqual({
        repo: "mobile",
        state: PropagationState.ON_PREDECESSOR,
        via_req_id: "BILLING-001",
        drifted: true,
      });

      const adminRow = rows.find((r) => r.repo === "admin") as PropagationRow;
      expect(adminRow).toEqual({
        repo: "admin",
        state: PropagationState.ON_OTHER_DOMAIN_REQ,
        via_req_id: "BILLING-007",
        drifted: false,
      });
    } finally {
      storage.close();
    }
  });

  test("spec-engine is never included in propagation rows (Pitfall 6 member-only filter)", async () => {
    const storage = await buildFixtureStorage();
    try {
      const rows = storage.propagationFor("BILLING-009");
      expect(rows.find((r) => r.repo === "spec-engine")).toBeUndefined();
    } finally {
      storage.close();
    }
  });

  test("BILLING-007 (unchanged Active req, no ancestors) classifies tagging members as MIGRATED_*", async () => {
    // BILLING-007 is Active and not superseded by anything; nothing supersedes
    // INTO it either. So the ancestors CTE is empty. Every member that tags
    // BILLING-007 directly lands MIGRATED_VERIFIED (if any tag is `verifies`)
    // or MIGRATED_UNVERIFIED (implements only). Fixture trace:
    //   - api:    tags BILLING-007 in src/tax.ts (implements) + test/tax.test.ts (verifies unit) → MIGRATED_VERIFIED
    //   - admin:  tags BILLING-007 in src/reports.ts (implements) + test/reports.int.test.ts (verifies integration) → MIGRATED_VERIFIED
    //   - mobile: tags BILLING-007 in src/tax.ts only (implements, no verifies) → MIGRATED_UNVERIFIED
    const storage = await buildFixtureStorage();
    try {
      const rows = storage.propagationFor("BILLING-007");
      expect(rows.length).toBe(3);
      expect(rows.map((r) => r.repo)).toEqual(["admin", "api", "mobile"]);

      const adminRow = rows.find((r) => r.repo === "admin") as PropagationRow;
      expect(adminRow).toEqual({
        repo: "admin",
        state: PropagationState.MIGRATED_VERIFIED,
        via_req_id: null,
        drifted: false,
      });

      const apiRow = rows.find((r) => r.repo === "api") as PropagationRow;
      expect(apiRow).toEqual({
        repo: "api",
        state: PropagationState.MIGRATED_VERIFIED,
        via_req_id: null,
        drifted: false,
      });

      const mobileRow = rows.find((r) => r.repo === "mobile") as PropagationRow;
      expect(mobileRow).toEqual({
        repo: "mobile",
        state: PropagationState.MIGRATED_UNVERIFIED,
        via_req_id: null,
        drifted: false,
      });
    } finally {
      storage.close();
    }
  });

  test("non-existent target req still returns 3 rows (member-only filter); all NO_DOMAIN_REFERENCE, no exception", async () => {
    // When $target is not present in `requirements`, target_domain returns 0
    // rows so `(SELECT key FROM target_domain)` is NULL. SQL `r.key = NULL`
    // is always falsy under three-valued logic, so the ON_OTHER_DOMAIN_REQ
    // branch never matches. The ancestors CTE is also empty (no req has
    // superseded_by=BILLING-404). All rows fall through to
    // NO_DOMAIN_REFERENCE. via_req_id is null and the drift lookup misses
    // (drift set keyed by real (repo,req_id) pairs; BILLING-404 cannot
    // appear). The CLI command in plan 04-04 will still print 3 rows; this
    // is the documented "missing target" path, not a crash.
    const storage = await buildFixtureStorage();
    try {
      const rows = storage.propagationFor("BILLING-404");
      expect(rows.length).toBe(3);
      for (const row of rows) {
        expect(row.state).toBe(PropagationState.NO_DOMAIN_REFERENCE);
        expect(row.via_req_id).toBeNull();
        expect(row.drifted).toBe(false);
      }
    } finally {
      storage.close();
    }
  });

  test("predecessor-chain cycle guard: PROP_REPO_STATES_SQL contains `a.depth < 16` (Pitfall 3)", () => {
    // Structural regression guard. If a future refactor removes the bound
    // (e.g., 'just make the CTE recurse until convergence'), this fails
    // before runtime would. The grep-style assertion matches the same
    // substring the plan's acceptance criteria locks.
    const source = readFileSync(
      resolve(import.meta.dir, "..", "src", "storage", "sqlite.ts"),
      "utf8",
    );
    expect(source).toContain("a.depth < 16");
  });
});
