// packages/engine/test/query-cold-rebuild.test.ts
//
// Pitfall 2 regression lock: FTS5 stays in sync with the base `requirements`
// table across cold rebuilds (rm db + WAL/SHM siblings → re-runIndex) AND
// across warm rebuilds (re-runIndex without rm — exercises the `clearAll`
// → `DELETE FROM requirements` → `_ad` trigger → FTS row removal path).
//
// The structural prevention lives in packages/shared/src/schema.ts (the
// `_ai`/`_ad`/`_au` triggers on the external-content FTS5 virtual table).
// This test locks the property as an automated regression so any future
// "optimization" of `clearAll` (e.g., DROPping the FTS table instead of
// DELETE FROM requirements) immediately fails CI rather than silently
// returning stale results from `spec query`.
//
// Pattern mirrors check-ci-cold-rebuild.test.ts: cloneFixture per test
// (WR-06), warm-then-cold rebuild via runIndex, search via storage.searchFts
// at the seam (not the citty command surface — that's locked in
// cli-query-unit.test.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

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

// @spec QURY-002 unit
describe("spec query cold-rebuild (Pitfall 2 regression)", () => {
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
    // Step 1: warm — populate the DB.
    const s1 = openStorage(dbPath);
    try {
      await runIndex({ platformDir: clone, storage: s1 });
    } finally {
      s1.close();
    }
    // Step 2: assert the file exists.
    expect(existsSync(dbPath)).toBe(true);
    // Step 3: rm db + siblings (the trio matching commands/check.ts --ci).
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = dbPath + suffix;
      if (existsSync(target)) rmSync(target);
    }
    expect(existsSync(dbPath)).toBe(false);
    // Step 4: fresh open + reindex.
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
    // Step 1: warm — capture count.
    const s1 = openStorage(dbPath);
    let warmCount = 0;
    try {
      await runIndex({ platformDir: clone, storage: s1 });
      warmCount = s1.searchFts("subscription").length;
    } finally {
      s1.close();
    }
    // Step 2: rm db + siblings.
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = dbPath + suffix;
      if (existsSync(target)) rmSync(target);
    }
    // Step 3: cold rebuild + recount.
    const s2 = openStorage(dbPath);
    let coldCount = 0;
    try {
      await runIndex({ platformDir: clone, storage: s2 });
      coldCount = s2.searchFts("subscription").length;
    } finally {
      s2.close();
    }
    // Pitfall 2 invariant: any drift between warm and cold means the FTS
    // sync triggers (or clearAll) regressed.
    expect(coldCount).toBe(warmCount);
  });

  test("re-runIndex without rm (warm rebuild) still returns BILLING-009 for 'renewal charge'", async () => {
    // Locks the `clearAll` → `DELETE FROM requirements` → `_ad` trigger
    // → FTS row removal → re-INSERT → `_ai` trigger → FTS row insert
    // path. If any link in that chain breaks, this test fails — and
    // `spec query` would silently return zero or stale results on the
    // second invocation against the same DB.
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
