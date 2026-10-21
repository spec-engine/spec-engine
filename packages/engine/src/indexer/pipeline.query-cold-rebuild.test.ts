// FTS5 stays in sync only through the `_ai`/`_ad`/`_au` triggers on the
// external-content table (packages/shared/src/schema.ts). A `clearAll` that
// drops the FTS table instead of `DELETE FROM requirements` would leave
// `spec query` returning stale rows; these cases catch that.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openStorage } from "../storage/sqlite";
import { cloneFixture } from "../testing/cloneFixture";
import { runIndex } from "./pipeline";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let dbPath: string;

beforeEach(() => {
  clone = cloneFixture(FIXTURE);
  dbPath = join(clone, ".spec-engine", "index.sqlite");
  mkdirSync(join(clone, ".spec-engine"), { recursive: true });
});

afterEach(() => {
  rmSync(clone, { recursive: true, force: true });
});

// @spec QURY-009 unit
describe("spec query cold-rebuild", () => {
  test("warm index: searchFts('renewal charge') top hit is BILLING-009", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: clone, storage: s });
      const hits = s.searchFts("renewal charge");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.req_id).toBe("BILLING-009");
    } finally {
      s.close();
    }
  });

  test("cold rebuild: rm db + WAL/SHM + reindex → searchFts('renewal charge') top hit is still BILLING-009", async () => {
    const s1 = openStorage(dbPath);
    try {
      await runIndex({ platformDir: clone, storage: s1 });
    } finally {
      s1.close();
    }
    expect(existsSync(dbPath)).toBe(true);
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = dbPath + suffix;
      if (existsSync(target)) rmSync(target);
    }
    expect(existsSync(dbPath)).toBe(false);
    const s2 = openStorage(dbPath);
    try {
      await runIndex({ platformDir: clone, storage: s2 });
      const hits = s2.searchFts("renewal charge");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.req_id).toBe("BILLING-009");
    } finally {
      s2.close();
    }
  });

  test("warm vs cold parity: result counts for 'subscription' query are equal across rebuilds", async () => {
    const s1 = openStorage(dbPath);
    let warmCount = 0;
    try {
      await runIndex({ platformDir: clone, storage: s1 });
      warmCount = s1.searchFts("subscription").length;
    } finally {
      s1.close();
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = dbPath + suffix;
      if (existsSync(target)) rmSync(target);
    }
    const s2 = openStorage(dbPath);
    let coldCount = 0;
    try {
      await runIndex({ platformDir: clone, storage: s2 });
      coldCount = s2.searchFts("subscription").length;
    } finally {
      s2.close();
    }
    expect(coldCount).toBe(warmCount);
  });

  test("re-runIndex without rm (warm rebuild) still returns BILLING-009 for 'renewal charge'", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: clone, storage: s });
      await runIndex({ platformDir: clone, storage: s });
      const hits = s.searchFts("renewal charge");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.req_id).toBe("BILLING-009");
    } finally {
      s.close();
    }
  });
});
