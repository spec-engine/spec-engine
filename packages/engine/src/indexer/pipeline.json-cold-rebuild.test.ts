// packages/engine/src/indexer/pipeline.json-cold-rebuild.test.ts
//
// SC5 + STOR-02 regression lock: cold-rebuild `build_id` byte-identity holds
// over the committed planted-mess JSON domain fixture (`fixtures/json-fixture/`,
// a SEPARATE tree from the Markdown `fixtures/platform-fixture/`). A verbatim
// clone of cold-rebuild.test.ts's four assertions, pointed at the JSON fixture,
// plus a STOR-02 sources-untouched check. This is the property Phase 18's
// byte-checked migrate round-trip depends on, so it must be pinned now.
//
//   1. Warm re-index against the same DB file → identical build_id.
//   2. Delete DB + WAL/SHM siblings (Pitfall 8) → cold re-index → identical
//      build_id. The regex-free, deterministic `line` derivation from 17-02
//      (T-17-02) is what keeps this stable — a scan-order- or position-
//      dependent hash would fail here.
//   3. Three-run stability: A == B (warm) and A == C (cold).
//   4. Mutating one requirement's `statement` → DIFFERENT build_id
//      (negative-case sanity so the hash isn't trivially constant).
//
// Plus STOR-02: the read path is READ-ONLY — indexing never rewrites the
// SPEC.json sources.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStorage } from "../storage/sqlite";
import { specTag } from "../testing/cloneFixture";
import { entryOf, plantEdit } from "../testing/plant";
import { TestPlatform } from "../testing/platform";
import { runIndex } from "./pipeline";

const JSON_FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "json-fixture");
const BILLING_SPEC = join(JSON_FIXTURE, "spec-engine", "BILLING", "SPEC.json");

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-json-cold-rebuild-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Remove a sqlite DB file along with its `-wal` and `-shm` siblings
 *  (Pitfall 8 — leftover WAL files contaminate cold-rebuild assertions). */
function removeDbAndWalSiblings(path: string): void {
  for (const sfx of ["", "-wal", "-shm"]) {
    const p = path + sfx;
    if (existsSync(p)) rmSync(p);
  }
}

describe("cold-rebuild equivalence over the JSON domain fixture (SC5 / STOR-02)", () => {
  test("warm re-index against the same DB file → identical build_id", async () => {
    const s = openStorage(dbPath);
    try {
      const a = await runIndex({ platformDir: JSON_FIXTURE, storage: s });
      const b = await runIndex({ platformDir: JSON_FIXTURE, storage: s });
      expect(a.build_id).toBe(b.build_id);
      expect(a.build_id).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      s.close();
    }
  });

  test("rm DB + WAL/SHM siblings + fresh re-index → identical build_id", async () => {
    // Pass 1: warm index, capture build_id_A, then close.
    const s1 = openStorage(dbPath);
    const a = await runIndex({ platformDir: JSON_FIXTURE, storage: s1 });
    s1.close();

    // Cold: nuke the DB and its WAL/SHM siblings.
    removeDbAndWalSiblings(dbPath);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    // Pass 2: fresh open + index against the SAME JSON fixture.
    const s2 = openStorage(dbPath);
    const c = await runIndex({ platformDir: JSON_FIXTURE, storage: s2 });
    s2.close();

    expect(c.build_id).toBe(a.build_id);
  });

  test("three-run stability: A == B (warm) and A == C (cold) and B == C", async () => {
    // Pass 1 (warm)
    const s1 = openStorage(dbPath);
    const a = await runIndex({ platformDir: JSON_FIXTURE, storage: s1 });
    const b = await runIndex({ platformDir: JSON_FIXTURE, storage: s1 });
    s1.close();

    // Pass 2 (cold)
    removeDbAndWalSiblings(dbPath);
    const s2 = openStorage(dbPath);
    const c = await runIndex({ platformDir: JSON_FIXTURE, storage: s2 });
    s2.close();

    expect(a.build_id).toBe(b.build_id);
    expect(a.build_id).toBe(c.build_id);
    expect(b.build_id).toBe(c.build_id);
  });

  test("mutating a requirement's statement produces a DIFFERENT build_id (negative-case sanity)", async () => {
    // Capture the canonical JSON-fixture build_id.
    const sA = openStorage(dbPath);
    const a = await runIndex({ platformDir: JSON_FIXTURE, storage: sA });
    sA.close();

    // Build a tiny tmp platform: one Active BILLING requirement whose
    // statement is the fixture's BILLING-007 text altered by one trailing
    // byte, and a minimal `api/` member tagging it so discoverRepos returns
    // a member and the requirement is covered (a genuinely different
    // statement byte set MUST flip the hash).
    const modFixture = join(tmp, "modified-fixture");
    const fx = TestPlatform.at(modFixture);
    const billing = await fx.domain("BILLING", { owner: "drea" });
    const { id } = await billing.req({
      statement: "When a charge is made, compute tax per region at charge time.X",
      why: "Compliance.",
      livesIn: ["tax.ts"],
    });
    await fx.member("api", {
      pin: "spec-engine@2",
      files: { "src/tax.ts": `${specTag(id)}\nexport const computeTax = () => 0;\n` },
    });

    // Index the modified fixture into a fresh DB.
    const modDbPath = join(tmp, "modified.sqlite");
    const sB = openStorage(modDbPath);
    const b = await runIndex({ platformDir: modFixture, storage: sB });
    sB.close();

    expect(b.build_id).not.toBe(a.build_id);
    expect(b.build_id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("indexing the JSON fixture never rewrites the SPEC.json sources (STOR-02, read-only)", async () => {
    const before = readFileSync(BILLING_SPEC, "utf8");
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: JSON_FIXTURE, storage: s });
    } finally {
      s.close();
    }
    const after = readFileSync(BILLING_SPEC, "utf8");
    expect(after).toBe(before);
  });
});

// Phase 6 Plan 01 — Wave 0 RED: the two new derived tables (term_aliases,
// term_citations) must be (a) present-and-empty in the pipeline so cold-rebuild
// build_id stays byte-identical over a TERM-carrying platform, and (b) each
// owns a computeBuildId section so their content hashes into build_id — the
// cold-rebuild-identity guarantee must COVER them (the relations/provenance
// precedent). The byte-identity leg holds even RED (an empty section is
// deterministic); the RED signal is the section-label assertion, which fails
// until Plan 06-01 Task 2 adds the two labels to computeBuildId.
// @spec SCHM-016 unit
// @spec SCHM-017 unit
describe("TERM derived-table build_id coverage (TERM-01, dogfooded as SCHM)", () => {
  async function writeTermFixture(root: string): Promise<void> {
    // A TERM domain whose lone term carries every term field (term/aliases/
    // cites/section). Terms carry NO @spec tag and are excluded from code
    // coverage. No operation authors a term's own citation, so it is planted.
    const fx = TestPlatform.at(root);
    await fx.terms();
    const { id } = await fx.term({
      term: "Domain",
      definition: "Domain — a bounded area of the spec taxonomy.",
      aliases: ["namespace"],
      section: "Core nouns",
    });
    await plantEdit(root, "TERM", (doc) => {
      entryOf(doc, id).cites = [{ term: "TERM-003", pinned: 2 }];
    });
    await fx.member("api", { files: { "src/noop.ts": "export const noop = () => 0;\n" } });
  }

  test("cold-rebuild build_id is byte-identical over a TERM-carrying platform", async () => {
    const fixture = join(tmp, "term-fixture");
    await writeTermFixture(fixture);

    const s1 = openStorage(dbPath);
    const a = await runIndex({ platformDir: fixture, storage: s1 });
    s1.close();

    removeDbAndWalSiblings(dbPath);
    const s2 = openStorage(dbPath);
    const c = await runIndex({ platformDir: fixture, storage: s2 });
    s2.close();

    expect(c.build_id).toBe(a.build_id);
    expect(a.build_id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("computeBuildId hashes the term_aliases + term_citations sections", async () => {
    // Source-level assertion (mirrors schema.test.ts's version-semantics
    // grep): computeBuildId must declare a section for each new derived table
    // so cold-rebuild identity covers them. RED until the labels exist.
    const src = await Bun.file(new URL("../storage/sqlite.ts", import.meta.url)).text();
    expect(src).toContain('label: "term_aliases"');
    expect(src).toContain('label: "term_citations"');
  });
});
