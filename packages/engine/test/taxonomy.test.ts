// packages/engine/test/taxonomy.test.ts
//
// Phase 1 (Domain Charters) — Wave 0 RED doc-structure contract.
//
// This test PINS the structure the not-yet-authored `spec-engine/TAXONOMY.md`
// must satisfy. It is authored RED-first (TAXONOMY.md does not exist yet); the
// doc is written in Wave 2 (plan 01-03), at which point this test turns GREEN
// with no change to the assertions here.
//
// Dogfood — these tests carry the VERIFYING tags for the three doc-only CHRT
// requirements minted in plan 01-03 (path-derived kind = verifies; the
// requirements' `livesIn` records `@spec-engine/TAXONOMY.md`, and this test IS
// the verifying evidence that clears ORPHAN_REQ for a doc-only requirement):
// @spec CHRT-001 unit
// @spec CHRT-002 unit
// @spec CHRT-006 unit
//
// Assertions are STRUCTURAL only (presence of keys, markers, ids) — never prose
// exactness — so the doc's wording can evolve without breaking the contract.
// A missing TAXONOMY.md degrades to an empty string so the RED bar is a clean
// content-assertion failure, NOT an unhandled file-read throw.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Resolve to the repo-root platform dir: packages/engine/test → repo root.
const TAXONOMY_PATH = join(import.meta.dir, "..", "..", "..", "spec-engine", "TAXONOMY.md");

/** Load the doc under test, guarding a missing file so the RED failure lands as
 * a content-assertion failure rather than an unhandled Bun.file read throw. */
async function loadTaxonomy(): Promise<string> {
  if (!existsSync(TAXONOMY_PATH)) return "";
  return await Bun.file(TAXONOMY_PATH).text();
}

// The §4.5 target-taxonomy domain keys — one charter entry per key is required.
const TARGET_DOMAINS = [
  "INDX",
  "SCHM",
  "CHCK",
  "PROOF",
  "GATE",
  "GUARD",
  "OWNER",
  "DOMAIN",
  "REQ",
  "INIT",
  "PROP",
  "MAP",
  "QURY",
  "RSLV",
  "SERV",
];

// The shadow-id promotion backlog the charter doc must name (Phase 3 targets).
const SHADOW_ID_BACKLOG = ["QURY-01", "RSLV-01", "SERV-01", "PROP-02"];

// The six headline invariants, cited by their former POC ids (§4.8).
const FORMER_POC_INVARIANTS = ["POC-001", "POC-016", "POC-002", "POC-003", "POC-004", "POC-005"];

describe("TAXONOMY.md — per-domain charter structure (CHRT-01)", () => {
  test("names a charter entry for every §4.5 target domain key", async () => {
    const doc = await loadTaxonomy();
    for (const key of TARGET_DOMAINS) {
      expect(doc).toContain(key);
    }
  });

  test("carries a belongs / does-not-belong boundary marker per entry", async () => {
    const doc = await loadTaxonomy();
    expect(doc).toMatch(/belongs/i);
    expect(doc).toMatch(/does not belong/i);
  });

  test("states the 3-digit requirement-id-format rule", async () => {
    const doc = await loadTaxonomy();
    expect(doc).toMatch(/3-digit|three-digit/i);
  });

  test("names the shadow-id promotion backlog", async () => {
    const doc = await loadTaxonomy();
    for (const id of SHADOW_ID_BACKLOG) {
      expect(doc).toContain(id);
    }
  });
});

describe("TAXONOMY.md — requirement-authoring standard (CHRT-02)", () => {
  test("carries the GUARD-template phrase", async () => {
    const doc = await loadTaxonomy();
    // `<command/surface> <promise> when <condition>`
    expect(doc).toMatch(/when <condition>/);
    expect(doc).toMatch(/<promise>/);
  });

  test("names the cold-read standard", async () => {
    const doc = await loadTaxonomy();
    expect(doc).toMatch(/cold read/i);
  });

  test("states the requirement-anatomy triple (verifying=tests, livesIn+implementing=files, issues=provenance)", async () => {
    const doc = await loadTaxonomy();
    expect(doc).toMatch(/verifying/i);
    expect(doc).toMatch(/livesIn/);
    expect(doc).toMatch(/provenance/i);
  });
});

describe("TAXONOMY.md — six headline invariants by post-reorg domain (CHRT-06)", () => {
  test("names all six former-POC invariant ids", async () => {
    const doc = await loadTaxonomy();
    for (const id of FORMER_POC_INVARIANTS) {
      expect(doc).toContain(id);
    }
  });

  test("assigns them to their post-reorg target domains", async () => {
    const doc = await loadTaxonomy();
    for (const key of ["INDX", "SCHM", "CHCK", "PROP"]) {
      expect(doc).toContain(key);
    }
  });

  test("carries the id-reconcile note deferring exact successor ids to Phase 2", async () => {
    const doc = await loadTaxonomy();
    expect(doc).toMatch(/reconcile|Phase 2/);
  });
});
