import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FtsHit, Storage } from "@spec-engine/shared";
import { runIndex } from "../indexer/pipeline";
import { openStorage } from "./sqlite";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

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
  test("'renewal charge' returns BILLING-009 as top hit (porter stemming)", async () => {
    // The fixture text says `renews`, never `renewal`: only the shared porter
    // stem `renew` connects them.
    const storage = await buildFixtureStorage();
    try {
      const hits = storage.searchFts("renewal charge");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.req_id).toBe("BILLING-009");
    } finally {
      storage.close();
    }
  });

  // @spec QURY-006 unit
  test("superseded requirements never surface: BILLING-001 shares BILLING-009's text but is excluded", async () => {
    const storage = await buildFixtureStorage();
    try {
      const hits = storage.searchFts("renewal charge");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.map((h: FtsHit) => h.req_id)).not.toContain("BILLING-001");
      expect(hits.map((h: FtsHit) => h.req_id)).toContain("BILLING-009");
    } finally {
      storage.close();
    }
  });

  test("porter sanity: 'renews charge' also returns BILLING-009 as top hit", async () => {
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
      // Position is not pinned: other reqs may share the token.
      expect(hits.some((h) => h.req_id === "BILLING-009")).toBe(true);
    } finally {
      storage.close();
    }
  });

  test("non-matching query returns empty array, not an exception", async () => {
    // A plain alphanumeric token: FTS5 reads `-` as NOT and `:` as a column
    // filter, so a hyphenated probe would take the syntax-error path instead.
    const storage = await buildFixtureStorage();
    try {
      const hits = storage.searchFts("nonexistenttokenzzzzz");
      expect(hits).toEqual([]);
    } finally {
      storage.close();
    }
  });

  test("FTS5 syntax error surfaces as typed Error", async () => {
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
          const prev = hits[i - 1];
          const cur = hits[i];
          if (prev === undefined || cur === undefined) throw new Error("hit out of range");
          expect(cur.rank).toBeGreaterThanOrEqual(prev.rank);
        }
      }
    } finally {
      storage.close();
    }
  });
});
