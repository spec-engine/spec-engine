// packages/engine/test/storage-reads.test.ts
//
// Plan 05-03 / Task 1 — promote the three Phase 1 read stubs (`listRepos`,
// `listRequirements`, `getRequirement`) from `[]`/`null` to real prepared
// SELECTs and lock the contract at the storage seam against the canonical
// platform-fixture.
//
// These three methods feed the `/api/requirements*` HTTP routes that plan
// 05-03 Task 2 introduces (and the SSR pages plan 05-04 mounts onto the
// same Hono app). If a future refactor breaks column projection, ORDER BY,
// or the optional `key`/`status` filters, this file fails BEFORE any
// rendered output churns. D-08 grep-fence holds: SQL lives in
// storage/sqlite.ts only.
//
// Pattern mirrors storage-resolve.test.ts: cloneFixture → openStorage +
// runIndex → read via the storage seam. The fixture trace literals
// (5 requirements, 4 repos: AUTH-001, BILLING-001/002/007/009; spec-engine,
// api, admin, mobile) are encoded here directly — we DO NOT compute them
// from the indexer output.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

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

describe("storage read promotions (Phase 1 stubs → real SQL)", () => {
  test("(a) listRepos() returns 4 rows in alphabetic order (admin, api, mobile, spec-engine)", () => {
    const repos = storage.listRepos();
    expect(repos.map((r) => r.name)).toEqual(["admin", "api", "mobile", "spec-engine"]);
    // Row shape: every Repo column projected explicitly.
    for (const r of repos) {
      expect(typeof r.name).toBe("string");
      expect(typeof r.path).toBe("string");
      expect(typeof r.pinned_spec_version).toBe("number");
    }
  });

  test("(b) listRequirements() returns 5 requirements total (AUTH-001 + BILLING-001/002/007/009)", () => {
    const reqs = storage.listRequirements();
    const ids = reqs.map((r) => r.id).sort();
    expect(ids).toEqual(["AUTH-001", "BILLING-001", "BILLING-002", "BILLING-007", "BILLING-009"]);
    // Every Requirement column explicitly projected.
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

  test("(c) listRequirements({ key: 'BILLING' }) returns 4 rows, all key='BILLING'", () => {
    const reqs = storage.listRequirements({ key: "BILLING" });
    expect(reqs.length).toBe(4);
    for (const r of reqs) expect(r.key).toBe("BILLING");
    const ids = reqs.map((r) => r.id).sort();
    expect(ids).toEqual(["BILLING-001", "BILLING-002", "BILLING-007", "BILLING-009"]);
  });

  test("(d) listRequirements({ status: 'Superseded' }) returns 1 row (BILLING-001)", () => {
    const reqs = storage.listRequirements({ status: "Superseded" });
    expect(reqs.length).toBe(1);
    expect(reqs[0]?.id).toBe("BILLING-001");
    expect(reqs[0]?.status).toBe("Superseded");
  });

  test("(d2) listRequirements({ key: 'BILLING', status: 'Active' }) AND-composes filters → 3 rows", () => {
    // Defense-in-depth: both filters compose. Fixture has 4 BILLING reqs;
    // BILLING-001 is Superseded, so Active matches BILLING-002/007/009.
    const reqs = storage.listRequirements({ key: "BILLING", status: "Active" });
    const ids = reqs.map((r) => r.id).sort();
    expect(ids).toEqual(["BILLING-002", "BILLING-007", "BILLING-009"]);
  });

  test("(e) getRequirement('BILLING-009') returns the row with 'renews' / 'charge' text", () => {
    const row = storage.getRequirement("BILLING-009");
    expect(row).not.toBeNull();
    expect(row?.id).toBe("BILLING-009");
    expect(row?.key).toBe("BILLING");
    expect(row?.status).toBe("Active");
    // Fixture canonical text: "When a subscription renews, charge the saved
    // payment method at the current plan price, prorating mid-cycle plan
    // changes." — substring-test rather than full equality so future
    // wording tweaks don't churn this test.
    expect(row?.text).toContain("renews");
    expect(row?.text).toContain("charge");
  });

  test("(f) getRequirement('NOPE-001') returns null for an unknown id", () => {
    expect(storage.getRequirement("NOPE-001")).toBeNull();
  });

  // --- Phase 6 / plan 06-01 — getRepo promotion --------------------------
  // Phase 6 (`spec gate`) consumes `repo.pinned_spec_version` for the
  // GATE-01 VERSION_PIN check. The Phase 1 stub returned null
  // unconditionally; these tests lock the real-SELECT contract against
  // the canonical fixture (api pins @2, mobile pins @1).

  test("(g) getRepo('api') returns the row with pinned_spec_version=2", () => {
    const row = storage.getRepo("api");
    expect(row).not.toBeNull();
    expect(row?.name).toBe("api");
    expect(row?.pinned_spec_version).toBe(2);
    expect(typeof row?.path).toBe("string");
  });

  test("(h) getRepo('mobile') returns the row with pinned_spec_version=1", () => {
    // mobile/spec-engine.member.json pins `spec-engine@1` — critical fixture
    // truth for the GATE VERSION_PIN classifier in plan 06-04.
    const row = storage.getRepo("mobile");
    expect(row).not.toBeNull();
    expect(row?.name).toBe("mobile");
    expect(row?.pinned_spec_version).toBe(1);
  });

  test("(i) getRepo('does-not-exist-repo') returns null", () => {
    expect(storage.getRepo("does-not-exist-repo")).toBeNull();
  });

  test("(j) getRepo('') returns null (defensive bind-discipline regression)", () => {
    expect(storage.getRepo("")).toBeNull();
  });
});
