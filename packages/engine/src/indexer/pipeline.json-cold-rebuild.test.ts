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

/** Leftover `-wal`/`-shm` files would make a "cold" rebuild warm. */
function removeDbAndWalSiblings(path: string): void {
  for (const sfx of ["", "-wal", "-shm"]) {
    const p = path + sfx;
    if (existsSync(p)) rmSync(p);
  }
}

describe("cold-rebuild equivalence over the JSON domain fixture", () => {
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
    const s1 = openStorage(dbPath);
    const a = await runIndex({ platformDir: JSON_FIXTURE, storage: s1 });
    s1.close();

    removeDbAndWalSiblings(dbPath);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    const s2 = openStorage(dbPath);
    const c = await runIndex({ platformDir: JSON_FIXTURE, storage: s2 });
    s2.close();

    expect(c.build_id).toBe(a.build_id);
  });

  test("three-run stability: A == B (warm) and A == C (cold) and B == C", async () => {
    const s1 = openStorage(dbPath);
    const a = await runIndex({ platformDir: JSON_FIXTURE, storage: s1 });
    const b = await runIndex({ platformDir: JSON_FIXTURE, storage: s1 });
    s1.close();

    removeDbAndWalSiblings(dbPath);
    const s2 = openStorage(dbPath);
    const c = await runIndex({ platformDir: JSON_FIXTURE, storage: s2 });
    s2.close();

    expect(a.build_id).toBe(b.build_id);
    expect(a.build_id).toBe(c.build_id);
    expect(b.build_id).toBe(c.build_id);
  });

  test("mutating a requirement's statement produces a different build_id", async () => {
    const sA = openStorage(dbPath);
    const a = await runIndex({ platformDir: JSON_FIXTURE, storage: sA });
    sA.close();

    // BILLING-007's statement with one trailing byte added.
    const modFixture = join(tmp, "modified-fixture");
    const fx = TestPlatform.at(modFixture);
    const billing = await fx.domain("BILLING", { owner: "drea" });
    const { id } = await billing.req({
      statement: "When a charge is made, compute tax per region at charge time X.",
      why: "Compliance.",
    });
    await fx.member("api", {
      pin: "spec-engine@2",
      files: { "src/tax.ts": `${specTag(id)}\nexport const computeTax = () => 0;\n` },
    });

    const modDbPath = join(tmp, "modified.sqlite");
    const sB = openStorage(modDbPath);
    const b = await runIndex({ platformDir: modFixture, storage: sB });
    sB.close();

    expect(b.build_id).not.toBe(a.build_id);
    expect(b.build_id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("indexing the JSON fixture never rewrites the SPEC.json sources", async () => {
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

// @spec SCHM-016 unit
// @spec SCHM-017 unit
describe("TERM derived-table build_id coverage", () => {
  async function writeTermFixture(root: string): Promise<void> {
    // No operation authors a term's own citation, so it is planted.
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
    const src = await Bun.file(new URL("../storage/sqlite.ts", import.meta.url)).text();
    expect(src).toContain('label: "term_aliases"');
    expect(src).toContain('label: "term_citations"');
  });
});
