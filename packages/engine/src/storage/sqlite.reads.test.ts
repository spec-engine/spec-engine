// The fixture's requirement and repo sets are written out literally, never
// computed from the indexer output.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { runIndex } from "../indexer/pipeline";
import { cloneFixture } from "../testing/cloneFixture";
import { openStorage } from "./sqlite";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let storage: Storage;

beforeAll(async () => {
  clone = cloneFixture(FIXTURE);
  storage = openStorage(join(clone, ".spec-engine", "index.sqlite"));
  await runIndex({ platformDir: clone, storage });
});

afterAll(() => {
  storage.close();
  rmSync(clone, { recursive: true, force: true });
});

describe("storage reads against canonical platform-fixture", () => {
  test("listRepos() returns 4 rows in alphabetic order (admin, api, mobile, spec-engine)", () => {
    const repos = storage.listRepos();
    expect(repos.map((r) => r.name)).toEqual(["admin", "api", "mobile", "spec-engine"]);
    for (const r of repos) {
      expect(typeof r.name).toBe("string");
      expect(typeof r.path).toBe("string");
      expect(typeof r.pinned_spec_version).toBe("number");
    }
  });

  test("listRequirements() returns 5 requirements total (AUTH-001 + BILLING-001/002/007/009)", () => {
    const reqs = storage.listRequirements();
    const ids = reqs.map((r) => r.id).sort();
    expect(ids).toEqual(["AUTH-001", "BILLING-001", "BILLING-002", "BILLING-007", "BILLING-009"]);
    for (const r of reqs) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.key).toBe("string");
      expect(typeof r.seq).toBe("number");
      expect(typeof r.status).toBe("string");
      expect(typeof r.text).toBe("string");
      expect(typeof r.source_file).toBe("string");
      expect(typeof r.line).toBe("number");
      expect(typeof r.spec_version).toBe("number");
      expect(typeof r.changed_at_version).toBe("number");
    }
  });

  test("listRequirements({ key: 'BILLING' }) returns 4 rows, all key='BILLING'", () => {
    const reqs = storage.listRequirements({ key: "BILLING" });
    expect(reqs.length).toBe(4);
    for (const r of reqs) expect(r.key).toBe("BILLING");
    const ids = reqs.map((r) => r.id).sort();
    expect(ids).toEqual(["BILLING-001", "BILLING-002", "BILLING-007", "BILLING-009"]);
  });

  test("listRequirements({ status: 'Superseded' }) returns 1 row (BILLING-001)", () => {
    const reqs = storage.listRequirements({ status: "Superseded" });
    expect(reqs.length).toBe(1);
    expect(reqs[0]?.id).toBe("BILLING-001");
    expect(reqs[0]?.status).toBe("Superseded");
  });

  test("listRequirements({ key: 'BILLING', status: 'Active' }) AND-composes filters → 3 rows", () => {
    const reqs = storage.listRequirements({ key: "BILLING", status: "Active" });
    const ids = reqs.map((r) => r.id).sort();
    expect(ids).toEqual(["BILLING-002", "BILLING-007", "BILLING-009"]);
  });

  test("getRequirement('BILLING-009') returns the row with 'renews' / 'charge' text", () => {
    const row = storage.getRequirement("BILLING-009");
    expect(row).not.toBeNull();
    expect(row?.id).toBe("BILLING-009");
    expect(row?.key).toBe("BILLING");
    expect(row?.status).toBe("Active");
    // Substrings, not equality, so a fixture rewording does not churn this.
    expect(row?.text).toContain("renews");
    expect(row?.text).toContain("charge");
  });

  test("getRequirement('NOPE-001') returns null for an unknown id", () => {
    expect(storage.getRequirement("NOPE-001")).toBeNull();
  });

  test("getRepo('api') returns the row with pinned_spec_version=2", () => {
    const row = storage.getRepo("api");
    expect(row).not.toBeNull();
    expect(row?.name).toBe("api");
    expect(row?.pinned_spec_version).toBe(2);
    expect(typeof row?.path).toBe("string");
  });

  test("getRepo('mobile') returns the row with pinned_spec_version=1", () => {
    const row = storage.getRepo("mobile");
    expect(row).not.toBeNull();
    expect(row?.name).toBe("mobile");
    expect(row?.pinned_spec_version).toBe(1);
  });

  test("getRepo('does-not-exist-repo') returns null", () => {
    expect(storage.getRepo("does-not-exist-repo")).toBeNull();
  });

  test("getRepo('') returns null", () => {
    expect(storage.getRepo("")).toBeNull();
  });
});
