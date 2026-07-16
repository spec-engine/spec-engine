// packages/engine/test/fts.test.ts
//
// Plan 04-03 / Task 2 — lock QURY-01 + QURY-02 at the storage seam. The
// `searchFts` method (storage/sqlite.ts) is the single SQL+TS surface every
// higher-level member (plan 04-05's `spec query` command, the webapp in
// Phase 5) reads through. If a future refactor breaks bm25 ranking, drops the
// porter tokenizer, or starts silently swallowing FTS5 grammar errors, this
// file fails before any rendered output churns.
//
// The headline test is the empirical proof of the porter stemming claim
// (04-RESEARCH Assumptions A1): `searchFts("renewal charge")` returns
// BILLING-009 even though the fixture text contains `renews`, not `renewal`.
// That's the moment Plan 04-01's SCHEMA_VERSION bump and tokenizer change
// earn their keep.
//
// Pattern mirrors check-drift-view.test.ts and propagation.test.ts: a tmp
// dbPath per test, openStorage + runIndex against the canonical fixture,
// then read via storage.searchFts(...).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FtsHit, Storage } from "@spec-engine/shared";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-fts-"));
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

describe("storage.searchFts against canonical platform-fixture", () => {
  test("QURY-02 happy path: 'renewal charge' returns BILLING-009 as top hit (porter stemming claim A1)", async () => {
    // Empirically validates 04-RESEARCH Assumptions A1: porter reduces both
    // `renewal` (in the query) and `renews` (in BILLING-009.text) to the
    // shared stem `renew`. Without the tokenizer change in plan 04-01 this
    // query returned zero rows; with it, BILLING-009 ranks first.
    const storage = await buildFixtureStorage();
    try {
      const hits = storage.searchFts("renewal charge");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.req_id).toBe("BILLING-009");
    } finally {
      storage.close();
    }
  });

  test("porter sanity: 'renews charge' also returns BILLING-009 as top hit", async () => {
    // Sanity check that porter does not LOSE matches it would have had under
    // the default unicode61 tokenizer — both the stemmed and un-stemmed
    // forms must surface BILLING-009.
    const storage = await buildFixtureStorage();
    try {
      const hits = storage.searchFts("renews charge");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.req_id).toBe("BILLING-009");
    } finally {
      storage.close();
    }
  });

  test("broad-keyword match: 'subscription' returns BILLING-009 in the result set", async () => {
    const storage = await buildFixtureStorage();
    try {
      const hits = storage.searchFts("subscription");
      // Don't pin position — other reqs may share the token. Just assert
      // BILLING-009 is somewhere in the hit set (baseline FTS5 wiring proof).
      expect(hits.some((h) => h.req_id === "BILLING-009")).toBe(true);
    } finally {
      storage.close();
    }
  });

  test("non-matching query returns empty array, not an exception", async () => {
    // Use a plain alphanumeric token: FTS5 treats `-` as a NOT operator and
    // `:` as a column-filter, so "nonexistent-token-zzzzz" would parse as
    // grammar and throw. The intent of this test is the empty-result path,
    // not the syntax-error path (that's covered separately below).
    const storage = await buildFixtureStorage();
    try {
      const hits = storage.searchFts("nonexistenttokenzzzzz");
      expect(hits).toEqual([]);
    } finally {
      storage.close();
    }
  });

  test("FTS5 syntax error surfaces as typed Error (Pitfall 8)", async () => {
    // FTS5 parses bare `AND OR` as grammar operators with no operands → it
    // throws a syntax error. The storage seam must surface that as a typed
    // throw (with the documented prefix), never silently return [].
    const storage = await buildFixtureStorage();
    try {
      expect(() => storage.searchFts("AND OR")).toThrow(/^searchFts: FTS5 query syntax error/);
    } finally {
      storage.close();
    }
  });

  test("limit parameter caps result count", async () => {
    const storage = await buildFixtureStorage();
    try {
      const limited = storage.searchFts("subscription", 1);
      expect(limited.length).toBeLessThanOrEqual(1);
    } finally {
      storage.close();
    }
  });

  test("FtsHit row shape: every result carries req_id + source_file + line + rank", async () => {
    const storage = await buildFixtureStorage();
    try {
      const hits = storage.searchFts("subscription");
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(typeof hit.req_id).toBe("string");
        expect(hit.req_id).toMatch(/^[A-Z]+-\d+$/);
        expect(typeof hit.source_file).toBe("string");
        expect(typeof hit.line).toBe("number");
        expect(typeof hit.rank).toBe("number");
      }
    } finally {
      storage.close();
    }
  });

  test("results sorted by rank ascending (best first per SQLite bm25 negative-multiplier convention)", async () => {
    const storage = await buildFixtureStorage();
    try {
      const hits: FtsHit[] = storage.searchFts("subscription");
      if (hits.length >= 2) {
        for (let i = 1; i < hits.length; i++) {
          // Lower rank = better; assert monotonic non-decreasing order.
          expect(hits[i]?.rank).toBeGreaterThanOrEqual(hits[i - 1]?.rank);
        }
      }
    } finally {
      storage.close();
    }
  });
});
