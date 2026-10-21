import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("storage.resolveByFiles against canonical platform-fixture", () => {
  test("['api/src/renew.ts', 'api/src/charge.ts'] returns BILLING-009 + BILLING-002", () => {
    const rows = storage.resolveByFiles(["api/src/renew.ts", "api/src/charge.ts"]);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["BILLING-002", "BILLING-009"]);
  });

  test("empty input returns []", () => {
    expect(storage.resolveByFiles([])).toEqual([]);
  });

  test("DISTINCT collapse: same requirement tagged via both implements and verifies → ONE row", () => {
    const rows = storage.resolveByFiles(["api/src/renew.ts", "api/test/renew.e2e.test.ts"]);
    const billing009Rows = rows.filter((r) => r.id === "BILLING-009");
    expect(billing009Rows.length).toBe(1);
  });

  test("deterministic ordering: results sorted by (key, seq) ascending", () => {
    const rows = storage.resolveByFiles(["api/src/renew.ts", "api/src/charge.ts"]);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(["BILLING-002", "BILLING-009"]);
  });

  test("unknown file returns []", () => {
    expect(storage.resolveByFiles(["api/src/no-such-file.ts"])).toEqual([]);
  });

  test("multi-repo guard: un-prefixed 'src/renew.ts' returns [] (no self-member expansion)", () => {
    expect(storage.resolveByFiles(["src/renew.ts"])).toEqual([]);
  });
});

// A lone repo stores tag files as `<repo-basename>/<rel>`, so the natural
// `src/orders.ts` must be expanded to match. The DB lives in a tmpdir so the
// committed fixture tree is never mutated.
describe("storage.resolveByFiles in self-member (rung-1) mode", () => {
  const SINGLE_REPO_FIXTURE = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "fixtures",
    "single-repo-fixture",
  );

  let tmp: string;
  let rung1: Storage;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "spec-resolve-rung1-"));
    rung1 = openStorage(join(tmp, "index.sqlite"));
    await runIndex({ platformDir: SINGLE_REPO_FIXTURE, storage: rung1 });
  });

  afterAll(() => {
    rung1.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("natural platform-relative path 'src/orders.ts' resolves ORDERS-001 + ORDERS-002", () => {
    const ids = rung1.resolveByFiles(["src/orders.ts"]).map((r) => r.id);
    expect(ids).toEqual(["ORDERS-001", "ORDERS-002"]);
  });

  test("basename-prefixed form 'single-repo-fixture/src/orders.ts' keeps working", () => {
    const ids = rung1.resolveByFiles(["single-repo-fixture/src/orders.ts"]).map((r) => r.id);
    expect(ids).toEqual(["ORDERS-001", "ORDERS-002"]);
  });

  test("both forms in one call collapse via DISTINCT (no duplicate rows)", () => {
    const ids = rung1
      .resolveByFiles(["src/orders.ts", "single-repo-fixture/src/orders.ts"])
      .map((r) => r.id);
    expect(ids).toEqual(["ORDERS-001", "ORDERS-002"]);
  });

  test("natural test path 'test/orders.test.ts' resolves the verifies tag (ORDERS-001)", () => {
    const ids = rung1.resolveByFiles(["test/orders.test.ts"]).map((r) => r.id);
    expect(ids).toEqual(["ORDERS-001"]);
  });

  test("unknown natural path still returns []", () => {
    expect(rung1.resolveByFiles(["src/no-such-file.ts"])).toEqual([]);
  });
});
