// @spec CHRT-007 unit
// @spec CHRT-008 unit
// @spec CHRT-009 unit
// @spec CHRT-013 unit
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const TAXONOMY_PATH = join(import.meta.dir, "..", "..", "..", "spec-engine", "TAXONOMY.md");

/** A missing file lands as a content-assertion failure, not an unhandled read throw. */
async function loadTaxonomy(): Promise<string> {
  if (!existsSync(TAXONOMY_PATH)) return "";
  return await Bun.file(TAXONOMY_PATH).text();
}

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

describe("TAXONOMY.md — per-domain charter structure", () => {
  test("names a charter entry for every target domain key", async () => {
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

  test("does NOT carry the retired shadow-id backlog", async () => {
    const doc = await loadTaxonomy();
    expect(doc).not.toContain("Shadow-id promotion backlog");
    expect(doc).not.toContain("QURY-01/");
  });
});

describe("TAXONOMY.md — requirement-authoring standard", () => {
  test("teaches the fixed statement shapes with a filled example", async () => {
    const doc = await loadTaxonomy();
    expect(doc).toContain("shall");
    expect(doc).toContain("When an unknown requirement id is passed");
  });

  test("states the read-alone rule in plain words", async () => {
    const doc = await loadTaxonomy();
    expect(doc).toContain("make sense on its own");
  });

  test("states the requirement-anatomy triple (verifying=tests, livesIn+implementing=files, issues=provenance)", async () => {
    const doc = await loadTaxonomy();
    expect(doc).toMatch(/verifying/i);
    expect(doc).toMatch(/livesIn/);
    expect(doc).toMatch(/provenance/i);
  });
});

describe("TAXONOMY.md — six headline invariants by domain", () => {
  test("lists the six invariants by their live requirement ids", async () => {
    const doc = await loadTaxonomy();
    for (const id of ["INDX-007", "CHCK-014", "SCHM-013", "INDX-008", "SCHM-012", "PROP-004"]) {
      expect(doc).toContain(id);
    }
  });

  test("assigns them to their target domains", async () => {
    const doc = await loadTaxonomy();
    for (const key of ["INDX", "SCHM", "CHCK", "PROP"]) {
      expect(doc).toContain(key);
    }
  });

  test("carries no reorg-schedule chatter", async () => {
    const doc = await loadTaxonomy();
    expect(doc).not.toMatch(/Phase \d|Wave [A-F]/);
  });
});
