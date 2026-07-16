// packages/engine/test/domainJson.test.ts
//
// TERM-03 (Phase 6, Wave C — citation resolution). The `cites[]` field on a
// requirement flattens into the derived `term_citations` table (mirroring
// flattenRelates → relations), and each citation resolves to a `term_id`:
//   - by TERM id (cited_as is a known TERM requirement id),
//   - by exact term name/alias (resolved via the aggregate term_aliases map),
//   - or NULL when unresolvable (Invariant #4 — the row still lands so Wave-D's
//     UNDEFINED_TERM can fire).
//
// The `term`/`aliases` fields on a TERM requirement flatten into `term_aliases`
// (one row per canonical name AND each alias), which is the name→id map the
// citation-by-name resolution consumes. Resolution is a PIPELINE concern (it
// needs the WHOLE platform's terms, not one spec's), so this integration test
// drives the full runIndex and reads the derived tables back through storage.
//
// Scaffolding mirrors json-index.test.ts (mkdtempSync / openStorage / runIndex).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-domainjson-cites-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Write a tmp platform with:
 *   - a TERM domain: TERM-001 term="Domain" aliases=["namespace"],
 *   - a BILLING domain: three reqs citing the term BY ID, BY NAME, and BY a
 *     ghost (unresolvable) surface form.
 */
async function writeCitesFixture(root: string): Promise<void> {
  await mkdir(join(root, "spec-engine", "TERM"), { recursive: true });
  await mkdir(join(root, "spec-engine", "BILLING"), { recursive: true });
  await mkdir(join(root, "api", "src"), { recursive: true });

  await writeFile(
    join(root, "spec-engine", "TERM", "SPEC.json"),
    JSON.stringify(
      {
        key: "TERM",
        owner: null,
        specVersion: 1,
        updated: "2026-07-08",
        requirements: [
          {
            id: "TERM-001",
            status: "Active",
            statement: "Domain — a bounded area of the spec taxonomy.",
            term: "Domain",
            aliases: ["namespace"],
            section: "Core nouns",
          },
        ],
      },
      null,
      2,
    ),
  );

  await writeFile(
    join(root, "spec-engine", "BILLING", "SPEC.json"),
    JSON.stringify(
      {
        key: "BILLING",
        owner: "drea",
        specVersion: 1,
        updated: "2026-07-08",
        requirements: [
          {
            id: "BILLING-001",
            status: "Active",
            statement: "A charge belongs to exactly one billing Domain.",
            cites: [{ term: "TERM-001", pinned: 1 }],
          },
          {
            id: "BILLING-002",
            status: "Active",
            statement: "Every invoice names its Domain.",
            cites: [{ term: "Domain", pinned: 1 }],
          },
          {
            id: "BILLING-003",
            status: "Active",
            statement: "A refund cites a ghost term nobody defined.",
            cites: [{ term: "Ghost", pinned: 1 }],
          },
        ],
      },
      null,
      2,
    ),
  );

  await writeFile(
    join(root, "api", "spec-engine.member.json"),
    JSON.stringify({ specs: "spec-engine@1" }, null, 2),
  );
  await writeFile(join(root, "api", "src", "noop.ts"), "export const noop = () => 0;\n");
}

// @spec INDX-005 unit
describe("cites → term_citations resolution (TERM-03)", () => {
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
      // Cite BY id (TERM-001) → resolves to TERM-001.
      expect(byReq.get("BILLING-001")?.term_id).toBe("TERM-001");
      expect(byReq.get("BILLING-001")?.cited_as).toBe("TERM-001");
      // Cite BY name ("Domain") → resolves to the SAME term_id via term_aliases.
      expect(byReq.get("BILLING-002")?.term_id).toBe("TERM-001");
      expect(byReq.get("BILLING-002")?.cited_as).toBe("Domain");
      // Cite BY a ghost surface form → term_id NULL (Invariant #4 — still lands).
      expect(byReq.get("BILLING-003")?.term_id).toBeNull();
      expect(byReq.get("BILLING-003")?.cited_as).toBe("Ghost");
      // pinned_version round-trips.
      expect(byReq.get("BILLING-001")?.pinned_version).toBe(1);
    } finally {
      s.close();
    }
  });

  // CR-01 regression: the schema allows an optional `aliases`/`term` on ANY
  // requirement, but only TERM-domain entries may contribute to the name→term_id
  // resolution map. A stray alias on a NON-TERM req must not enter term_aliases
  // (a non-TERM id sorts before "TERM" and would hijack a colliding term name
  // under first-wins, firing a spurious gating UNDEFINED_TERM).
  test("a non-TERM requirement's aliases never pollute term resolution (CR-01)", async () => {
    const fixture = join(tmp, "alias-pollution-fixture");
    await mkdir(join(fixture, "spec-engine", "TERM"), { recursive: true });
    await mkdir(join(fixture, "spec-engine", "BILLING"), { recursive: true });
    await writeFile(
      join(fixture, "spec-engine", "TERM", "SPEC.json"),
      JSON.stringify(
        {
          key: "TERM",
          owner: null,
          specVersion: 1,
          updated: "2026-07-08",
          requirements: [
            {
              id: "TERM-001",
              status: "Active",
              statement: "The canonical Domain term.",
              term: "Domain",
            },
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(fixture, "spec-engine", "BILLING", "SPEC.json"),
      JSON.stringify(
        {
          key: "BILLING",
          owner: "drea",
          specVersion: 1,
          updated: "2026-07-08",
          requirements: [
            // Malicious/stray: a NON-TERM req claiming the term name "Domain".
            {
              id: "BILLING-001",
              status: "Active",
              statement: "A charge.",
              term: "Domain",
              aliases: ["Domain"],
            },
            // A legit name-cite that must still resolve to the real TERM-001.
            {
              id: "BILLING-002",
              status: "Active",
              statement: "Cites Domain by name.",
              cites: [{ term: "Domain", pinned: 1 }],
            },
          ],
        },
        null,
        2,
      ),
    );
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: fixture, storage: s });
      // Only the TERM entry contributes to the alias map — BILLING-001 is absent.
      expect(s.listTermAliases()).toEqual([{ term_id: "TERM-001", name: "Domain" }]);
      // The name-cite resolves to the real term, not hijacked to BILLING-001.
      const cite = s.listTermCitations().find((c) => c.req_id === "BILLING-002");
      expect(cite?.term_id).toBe("TERM-001");
    } finally {
      s.close();
    }
  });
});
