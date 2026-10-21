// This indexes the repo's own committed store. The FTS covers a term's
// definition and `why`, not its name, so the probe words are tied to that
// store: "ephemeral" appears only in TERM-029's definition, and "index" in
// TERM-016's. Rewording either term breaks these tests.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FtsHit, Storage } from "@spec-engine/shared";
import { runIndex } from "../indexer/pipeline";
import { openStorage } from "../storage/sqlite";
import { renderQuery } from "./format";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "spec-query-terms-"));
  storage = openStorage(join(tmp, "index.sqlite"));
  await runIndex({ platformDir: REPO_ROOT, storage });
});

afterAll(() => {
  storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("spec query surfaces term definitions beside requirement hits", () => {
  // @spec QURY-008 unit
  test("term hit surfaces with key='TERM' (definition-word match on the real store)", () => {
    const hits = storage.searchFts("ephemeral", 100);
    const term = hits.find((h) => h.req_id === "TERM-029");
    expect(term).toBeDefined();
    expect(term?.key).toBe("TERM");
  });

  test("renderQuery groups TERM hits into a Terms section beside Requirements", () => {
    const hits = storage.searchFts("index", 200);
    const termHits = hits.filter((h) => h.key === "TERM");
    const reqHits = hits.filter((h) => h.key !== "TERM");
    expect(termHits.length).toBeGreaterThan(0);
    expect(reqHits.length).toBeGreaterThan(0);

    const out = renderQuery(hits, "text");
    expect(out).toMatch(/Terms/);
    expect(out).toMatch(/Requirements/);
    expect(out).toContain("TERM-016");
    expect(reqHits.some((h) => out.includes(h.req_id))).toBe(true);
  });

  test("query --json is byte-stable across two runs and carries the key discriminator", () => {
    const hits = storage.searchFts("index", 200);
    const a = renderQuery(hits, "json");
    const b = renderQuery(hits, "json");
    expect(a).toBe(b);
    const parsed = JSON.parse(a) as FtsHit[];
    expect(parsed.length).toBeGreaterThan(0);
    for (const hit of parsed) {
      expect(typeof hit.key).toBe("string");
    }
    expect(parsed.some((h) => h.key === "TERM")).toBe(true);
  });

  test("coverage invariance: a query-visible term stays OUT of coverage/map", () => {
    // The TERM exclusion lives on the coverage view in schema.ts, not on FTS.
    const hits = storage.searchFts("ephemeral", 100);
    expect(hits.some((h) => h.req_id === "TERM-029")).toBe(true);

    const coverage = storage.coverageMatrix();
    expect(coverage.some((row) => row.req_id.startsWith("TERM-"))).toBe(false);
  });
});
