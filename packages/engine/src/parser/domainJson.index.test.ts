// Resolution needs the whole platform's terms, so these drive the full
// runIndex rather than the reader alone.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndex } from "../indexer/pipeline";
import { openStorage } from "../storage/sqlite";
import { TestPlatform } from "../testing/platform";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-domainjson-cites-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function writeCitesFixture(root: string): Promise<void> {
  const fx = TestPlatform.at(root);
  await fx.terms();
  await fx.term({
    term: "Domain",
    definition: "Domain — a bounded area of the spec taxonomy.",
    aliases: ["namespace"],
    section: "Core nouns",
  });
  const billing = await fx.domain("BILLING", { owner: "drea" });
  await billing.req({
    statement: "A charge belongs to exactly one billing Domain.",
    cites: [{ term: "TERM-001", pinned: 1 }],
  });
  await billing.req({
    statement: "Every invoice names its Domain.",
    cites: [{ term: "Domain", pinned: 1 }],
  });
  await billing.req({
    statement: "A refund cites a ghost term nobody defined.",
    cites: [{ term: "Ghost", pinned: 1 }],
  });
  await fx.member("api", { files: { "src/noop.ts": "export const noop = () => 0;\n" } });
}

// @spec INDX-026 unit
describe("cites → term_citations resolution", () => {
  test("term/aliases flatten to term_aliases (canonical name + each alias)", async () => {
    const fixture = join(tmp, "cites-fixture");
    await writeCitesFixture(fixture);
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: fixture, storage: s });
      const aliases = s.listTermAliases();
      expect(aliases).toEqual([
        { term_id: "TERM-001", name: "Domain" },
        { term_id: "TERM-001", name: "namespace" },
      ]);
    } finally {
      s.close();
    }
  });

  test("id-cite and name-cite resolve to the same term_id; ghost cite is NULL", async () => {
    const fixture = join(tmp, "cites-fixture");
    await writeCitesFixture(fixture);
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: fixture, storage: s });
      const cites = s.listTermCitations();
      const byReq = new Map(cites.map((c) => [c.req_id, c]));

      expect(cites.length).toBe(3);
      expect(byReq.get("BILLING-001")?.term_id).toBe("TERM-001");
      expect(byReq.get("BILLING-001")?.cited_as).toBe("TERM-001");
      expect(byReq.get("BILLING-002")?.term_id).toBe("TERM-001");
      expect(byReq.get("BILLING-002")?.cited_as).toBe("Domain");
      expect(byReq.get("BILLING-003")?.term_id).toBeNull();
      expect(byReq.get("BILLING-003")?.cited_as).toBe("Ghost");
      expect(byReq.get("BILLING-001")?.pinned_version).toBe(1);
    } finally {
      s.close();
    }
  });

  test("a non-TERM requirement's aliases never pollute term resolution", async () => {
    const fixture = join(tmp, "alias-pollution-fixture");
    const fx = TestPlatform.at(fixture);
    await fx.terms();
    await fx.term({ term: "Domain", definition: "The canonical Domain term." });
    const billing = await fx.domain("BILLING", { owner: "drea" });
    const stray = await billing.req({ statement: "A charge." });
    await billing.amend(stray.id, { term: "Domain", aliases: ["Domain"] });
    await billing.req({
      statement: "Cites Domain by name.",
      cites: [{ term: "Domain", pinned: 1 }],
    });
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: fixture, storage: s });
      expect(s.listTermAliases()).toEqual([{ term_id: "TERM-001", name: "Domain" }]);
      const cite = s.listTermCitations().find((c) => c.req_id === "BILLING-002");
      expect(cite?.term_id).toBe("TERM-001");
    } finally {
      s.close();
    }
  });
});
