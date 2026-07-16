// packages/engine/test/query-terms.test.ts
//
// TERM-07 (Phase 6, Wave G) — `spec query` surfaces GLOSSARY term definitions
// BESIDE requirement hits. Terms ARE requirement rows in the reserved TERM
// domain, so they already ride the existing `requirements_fts` index (their
// definition lives in the `statement` → `text` FTS column); this wave only adds
// a `key` discriminator to the FTS projection so a term hit is distinguishable
// from a requirement hit, and teaches renderQuery to group the two.
//
// These are the RED tests for that behavior — they fail until:
//   - FTS_SEARCH_SQL projects `r.key AS key` (sqlite.ts),
//   - FtsHit gains a `key` discriminator (shared/storage.ts),
//   - renderQuery groups `key === 'TERM'` hits into a Terms section (format.ts).
//
// Corpus note: the FTS indexes each term's DEFINITION (`statement`) + `why`,
// NOT the term NAME field, so the probe words below ("ephemeral", "index") are
// chosen because they appear inside term definitions in the real committed
// store (TERM-029 "Issue" → "ephemeral"; TERM-016 "Derived index" → "index").
//
// Pattern mirrors glossary-roundtrip.test.ts: index the REAL repo (which holds
// the 29 migrated terms after Wave F) into a throwaway tmp index and read
// through the storage seam.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FtsHit, Storage } from "@spec-engine/shared";
import { runIndex } from "../src/indexer/pipeline";
import { renderQuery } from "../src/query/format";
import { openStorage } from "../src/storage/sqlite";

// The real repo root (contains spec-engine/ with the 29 migrated TERM rows).
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

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

describe("TERM-07 — spec query surfaces term definitions beside requirement hits", () => {
  // @spec QURY-003 unit
  test("term hit surfaces with key='TERM' (definition-word match on the real store)", () => {
    // "ephemeral" appears ONLY in TERM-029's definition across the whole
    // canonical store — a clean proof that a term surfaces via its definition.
    const hits = storage.searchFts("ephemeral", 100);
    const term = hits.find((h) => h.req_id === "TERM-029");
    expect(term).toBeDefined();
    // RED: FtsHit has no `key` yet + FTS_SEARCH_SQL does not project it, so
    // `term.key` is undefined here until Wave G lands.
    expect(term?.key).toBe("TERM");
  });

  test("renderQuery groups TERM hits into a Terms section beside Requirements", () => {
    // "index" matches many INDX/other requirements AND TERM-016 ("Derived
    // index") — so the render must show BOTH a Requirements group and a Terms
    // group, the term's definition rendered beside the req hits.
    const hits = storage.searchFts("index", 200);
    const termHits = hits.filter((h) => h.key === "TERM");
    const reqHits = hits.filter((h) => h.key !== "TERM");
    // Both populations must be present for this to be a real "beside" proof.
    expect(termHits.length).toBeGreaterThan(0);
    expect(reqHits.length).toBeGreaterThan(0);

    const out = renderQuery(hits, "text");
    // A distinct Terms section AND the existing Requirements section.
    expect(out).toMatch(/Terms/);
    expect(out).toMatch(/Requirements/);
    // The term's id and at least one requirement id both render.
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
    // Every serialized hit carries `key` (RED: absent from the projection).
    for (const hit of parsed) {
      expect(typeof hit.key).toBe("string");
    }
    expect(parsed.some((h) => h.key === "TERM")).toBe(true);
  });

  test("coverage invariance: a query-visible term stays OUT of coverage/map", () => {
    // The TERM exclusion lives on the coverage VIEW (schema.ts `WHERE r.key !=
    // 'TERM'`), NOT on FTS — so a term that answers a query must still be
    // absent from the coverage matrix `spec map` reads.
    const hits = storage.searchFts("ephemeral", 100);
    expect(hits.some((h) => h.req_id === "TERM-029")).toBe(true);

    const coverage = storage.coverageMatrix();
    expect(coverage.some((row) => row.req_id.startsWith("TERM-"))).toBe(false);
  });
});
