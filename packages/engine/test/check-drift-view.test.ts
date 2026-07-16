// packages/engine/test/check-drift-view.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec PROP-002
//
// Plan 03-02 / Task 1 (RED → GREEN in Task 2): assert the `drift` SQL VIEW
// behavior against the canonical platform-fixture. CHCK-03 requires DRIFT to
// live in a single SQL VIEW; CHCK-05 requires that the negative-case
// (mobile/src/tax.ts → BILLING-007 unchanged since v1, mobile pinned @1) does
// NOT fire DRIFT. Both invariants are locked here at the SQL layer.
//
// Pattern mirrors cold-rebuild.test.ts: mkdtempSync tmp dir, openStorage,
// runIndex to populate, then read via storage.listDriftRows() and assert.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runIndex } from "../src/indexer/pipeline";
import { inspectSchema, openStorage } from "../src/storage/sqlite";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-drift-view-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("drift VIEW behavior (CHCK-03, CHCK-05)", () => {
  test("positive case: mobile/src/billing.ts → BILLING-001 fires DRIFT", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
      const rows = s.listDriftRows();
      const match = rows.find((r) => r.repo === "mobile" && r.req_id === "BILLING-001");
      expect(match).toBeDefined();
      expect(match).toMatchObject({
        repo: "mobile",
        req_id: "BILLING-001",
        source_file: "mobile/src/billing.ts",
        req_changed_at_version: 2,
        repo_pin: 1,
        domain_key: "BILLING",
      });
    } finally {
      s.close();
    }
  });

  test("CHCK-05 negative case: mobile/src/tax.ts → BILLING-007 does NOT fire", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
      const rows = s.listDriftRows();
      const hits = rows.filter((r) => r.req_id === "BILLING-007");
      expect(hits.length).toBe(0);
    } finally {
      s.close();
    }
  });

  test("api/src/renew.ts → BILLING-009 does NOT fire (api@2, req changed_at=2)", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
      const rows = s.listDriftRows();
      const hits = rows.filter((r) => r.req_id === "BILLING-009");
      expect(hits.length).toBe(0);
    } finally {
      s.close();
    }
  });

  test("drift is a VIEW, not a TABLE (belt-and-suspenders against materialization)", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
    } finally {
      s.close();
    }
    const schema = inspectSchema(dbPath);
    expect(schema.views).toContain("drift");
    expect(schema.tables).not.toContain("drift");
  });

  test("DRIFT row count against canonical fixture is exactly 1", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
      const rows = s.listDriftRows();
      expect(rows.length).toBe(1);
    } finally {
      s.close();
    }
  });
});
