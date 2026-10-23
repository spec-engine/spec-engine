// @spec PROP-007

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type PropagationRow, PropagationState, type Storage } from "@spec-engine/shared";
import { runIndex } from "../../indexer/pipeline";
import { DEPENDENCY_MEMBERS, dependencyPlatform } from "../../testing/dependencyPlatform";
import { TestPlatform } from "../../testing/platform";
import { openStorage } from "../sqlite";
import { PROP_REPO_STATES_SQL } from "./propagation";

const FIXTURE = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "platform-fixture",
);

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

describe("propagationFor (5-state classifier)", () => {
  test("BILLING-009 fixture trace: api=MIGRATED_VERIFIED, mobile=ON_PREDECESSOR via BILLING-001 (drifted), admin=ON_OTHER_DOMAIN_REQ via BILLING-007", async () => {
    const storage = await buildFixtureStorage();
    try {
      const rows = storage.propagationFor("BILLING-009");

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

  test("spec-engine is never included in propagation rows (member-only filter)", async () => {
    const storage = await buildFixtureStorage();
    try {
      const rows = storage.propagationFor("BILLING-009");
      expect(rows.find((r) => r.repo === "spec-engine")).toBeUndefined();
    } finally {
      storage.close();
    }
  });

  test("BILLING-007 (unchanged Active req, no ancestors) classifies tagging members as MIGRATED_*", async () => {
    // In the fixture, mobile tags BILLING-007 from src/tax.ts only, with no
    // verifying tag; api and admin carry both kinds.
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
    // A missing target makes `(SELECT key FROM target_domain)` NULL, and
    // `r.key = NULL` is never true, so ON_OTHER_DOMAIN_REQ cannot match.
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

  test("predecessor-chain cycle guard: PROP_REPO_STATES_SQL contains `a.depth < 16`", () => {
    expect(PROP_REPO_STATES_SQL).toContain("a.depth < 16");
  });
});

describe("propagationFor row order", () => {
  // @spec PROP-006 unit
  test("rows come out by dependency depth, providers before consumers, ties by name", async () => {
    const fx = TestPlatform.temp("spec-propagation-order-");
    const storage = openStorage(dbPath);
    try {
      const { predecessor, head } = await dependencyPlatform(fx);
      await runIndex({ platformDir: fx.dir, storage });

      const rows = storage.propagationFor(head);

      expect(rows.map((r) => r.repo)).toEqual([...DEPENDENCY_MEMBERS.byDepth]);
      expect(rows.map((r) => r.state)).toEqual([
        PropagationState.MIGRATED_VERIFIED,
        PropagationState.NO_DOMAIN_REFERENCE,
        PropagationState.ON_PREDECESSOR,
        PropagationState.MIGRATED_UNVERIFIED,
      ]);
      expect(rows[2]?.via_req_id).toBe(predecessor);
    } finally {
      storage.close();
      fx.remove();
    }
  });
});
