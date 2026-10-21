// @spec PROP-004

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runIndex } from "../indexer/pipeline";
import { inspectSchema, openStorage } from "./sqlite";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-drift-view-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("drift VIEW behavior", () => {
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

  test("negative case: mobile/src/tax.ts → BILLING-007 does NOT fire", async () => {
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
