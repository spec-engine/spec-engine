// packages/engine/test/provenance-cold-rebuild.test.ts
//
// PROV-06 regression lock: provenance rows are pre-sorted before insert by a
// composite key that byte-matches the computeBuildId provenance ORDER BY, so
// the build_id is identical across warm re-index, cold rebuild (rm db +
// WAL/SHM), AND independent of the AUTHORED token order on the `**Issues:**`
// line. This is the cross-repo determinism contract for the provenance seam:
// if the pipeline pre-sort key (pipeline.ts sortedProvenance, ordered
// req_id, role, issue_id, source_file, line) ever drifts from the build_id
// projection ORDER BY (sqlite.ts computeBuildId provenance section, same
// column order), this test fails immediately rather than silently shipping a
// scan-order-dependent build_id.
//
// Three properties under test (storage + pipeline seams, not the citty
// surface — that is locked elsewhere):
//   1. Byte-identity (PROV-06): warm == cold == three-run, capture-and-compare,
//      NO frozen build_id constant.
//   2. Token-reorder equivalence (PROV-06 / SC4): a spec whose Issues tokens
//      are authored in a different order hashes to the SAME build_id — the
//      (req_id, role, issue_id) pre-sort makes authoring order irrelevant.
//   3. No-Issues backward-compat (PROV-04 at storage): a spec with no Issues
//      line indexes to zero provenance rows and a build_id stable across cold
//      rebuild.
//
// Pattern: clones `removeDbAndWalSiblings` + the three-run capture-and-compare
// structure from cold-rebuild.test.ts; builds a minimal tmp platform fixture
// per test (mkdtemp under os.tmpdir()) like the mutated-fixture case there.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";
import { specTag } from "./fixtures/specTag";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-prov-cold-rebuild-"));
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

/**
 * Build a minimal single-member platform fixture under `dir`, with one
 * Active requirement PROV-001 whose `issues[]` are parsed from `issuesLine`
 * (a `role:ID, role:ID` string, order preserved) or empty when `issuesLine`
 * is null. Returns the platform dir.
 *
 * D2: JSON is the sole spec format. The `role:ID` string interface is kept so
 * the token-reorder test can rewrite ONLY the issue ordering; the parsed order
 * is preserved into `issues[]` so the pipeline pre-sort is what makes build_id
 * order-independent (not the fixture writer).
 *
 * Mirrors the minimal-fixture shape used by cold-rebuild.test.ts's
 * mutated-fixture case: one SPEC.json, and one member with a
 * spec-engine.member.json + a tagged source file so discoverRepos returns a
 * member and the requirement is covered.
 */
async function buildFixture(dir: string, issuesLine: string | null): Promise<string> {
  await mkdir(join(dir, "spec-engine", "PROV"), { recursive: true });
  await mkdir(join(dir, "api", "src"), { recursive: true });

  const issues =
    issuesLine === null
      ? []
      : issuesLine.split(",").map((tok) => {
          const [role, id] = tok.trim().split(":");
          return { role: role as string, id: (id ?? "") as string };
        });
  const envelope = {
    key: "PROV",
    owner: "drea",
    specVersion: 2,
    updated: "",
    requirements: [
      {
        id: "PROV-001",
        status: "active",
        statement: "The renewal charge is computed at charge time per region.",
        why: "Compliance.",
        supersedes: null,
        supersededBy: null,
        relates: [],
        livesIn: [],
        issues,
      },
    ],
  };
  await writeFile(join(dir, "spec-engine", "PROV", "SPEC.json"), JSON.stringify(envelope, null, 2));

  await writeFile(
    join(dir, "api", "spec-engine.member.json"),
    JSON.stringify({ specs: "spec-engine@2" }, null, 2),
  );
  await writeFile(
    join(dir, "api", "src", "renew.ts"),
    `${specTag("PROV-001")}export const renew = () => 0;\n`,
  );

  return dir;
}

/** Index `platformDir` into a fresh DB at `dbPath`, return the build_id. */
async function indexBuildId(platformDir: string, dbPath: string): Promise<string> {
  const s = openStorage(dbPath);
  try {
    const r = await runIndex({ platformDir, storage: s });
    return r.build_id;
  } finally {
    s.close();
  }
}

describe("provenance cold-rebuild + token-reorder (PROV-06)", () => {
  test("byte-identity: warm == cold == three-run on a multi-issue Issues line", async () => {
    const fixture = await buildFixture(
      join(tmp, "fixture"),
      "created:ENG-1432, supersedes-via:ENG-1781, amends-via:ENG-2000",
    );
    const dbPath = join(tmp, "index.sqlite");

    // Pass 1 + 2 (warm, same DB file).
    const s1 = openStorage(dbPath);
    const a = await runIndex({ platformDir: fixture, storage: s1 });
    const b = await runIndex({ platformDir: fixture, storage: s1 });
    s1.close();

    // Pass 3 (cold: rm db + WAL/SHM siblings).
    removeDbAndWalSiblings(dbPath);
    expect(existsSync(dbPath)).toBe(false);
    const s2 = openStorage(dbPath);
    const c = await runIndex({ platformDir: fixture, storage: s2 });
    s2.close();

    expect(a.build_id).toMatch(/^[0-9a-f]{64}$/);
    expect(a.build_id).toBe(b.build_id); // warm re-index
    expect(a.build_id).toBe(c.build_id); // cold rebuild
    expect(b.build_id).toBe(c.build_id);
  });

  test("token-reorder: authored Issues order is irrelevant to build_id (SC4)", async () => {
    // CRITICAL: both variants MUST share the SAME platform dir. repos.path is
    // hashed into build_id (it stores the absolute member path), so building
    // the two variants in different tmp subdirs would diff the hash for a
    // reason unrelated to provenance order. We rewrite SPEC.json in place
    // between runs so the ONLY varying content is the issues[] token order.
    const platformDir = join(tmp, "fixture");

    // H1: the canonical authoring order.
    await buildFixture(
      platformDir,
      "created:ENG-1432, supersedes-via:ENG-1781, amends-via:ENG-2000",
    );
    const h1 = await indexBuildId(platformDir, join(tmp, "canonical.sqlite"));

    // Rewrite ONLY the Issues line into a reordered authoring of the SAME three
    // role:ID pairs — different bytes on the line, identical
    // (req_id, role, issue_id) set after the pipeline pre-sort.
    await buildFixture(
      platformDir,
      "supersedes-via:ENG-1781, amends-via:ENG-2000, created:ENG-1432",
    );
    const h2 = await indexBuildId(platformDir, join(tmp, "reordered.sqlite"));

    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    // The (req_id, role, issue_id) pre-sort byte-matches the build_id ORDER BY,
    // so the projection — and therefore the hash — is identical regardless of
    // the order the tokens were authored in.
    expect(h2).toBe(h1);
  });

  test("token-reorder negative-case sanity: a DIFFERENT issue set changes build_id", async () => {
    // Guards against the hash being trivially constant: a genuinely different
    // provenance set (one issue id changed) MUST produce a different build_id.
    // Same platform dir (repos.path held constant) so the ONLY varying byte is
    // an issue id — proving the provenance SECTION actually feeds build_id.
    const platformDir = join(tmp, "fixture");

    await buildFixture(platformDir, "created:ENG-1432, supersedes-via:ENG-1781");
    const hBase = await indexBuildId(platformDir, join(tmp, "base.sqlite"));

    await buildFixture(platformDir, "created:ENG-1432, supersedes-via:ENG-9999");
    const hAltered = await indexBuildId(platformDir, join(tmp, "altered.sqlite"));

    expect(hAltered).not.toBe(hBase);
    expect(hAltered).toMatch(/^[0-9a-f]{64}$/);
  });

  test("no-Issues backward-compat (PROV-04): zero provenance rows + build_id stable across cold rebuild", async () => {
    const fixture = await buildFixture(join(tmp, "no-issues"), null);
    const dbPath = join(tmp, "no-issues.sqlite");

    // Warm: assert zero provenance rows AND capture build_id.
    const s1 = openStorage(dbPath);
    const a = await runIndex({ platformDir: fixture, storage: s1 });
    expect(s1.listProvenance()).toEqual([]);
    s1.close();

    // Cold rebuild: build_id is stable (provenance section contributes the
    // same empty projection on every run).
    removeDbAndWalSiblings(dbPath);
    expect(existsSync(dbPath)).toBe(false);
    const s2 = openStorage(dbPath);
    const c = await runIndex({ platformDir: fixture, storage: s2 });
    expect(s2.listProvenance()).toEqual([]);
    s2.close();

    expect(a.build_id).toMatch(/^[0-9a-f]{64}$/);
    expect(a.build_id).toBe(c.build_id);
  });

  test("listProvenance returns rows in deterministic composite order on the multi-issue fixture", async () => {
    const fixture = await buildFixture(
      join(tmp, "ordered"),
      "supersedes-via:ENG-1781, amends-via:ENG-2000, created:ENG-1432",
    );
    const dbPath = join(tmp, "ordered.sqlite");
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: fixture, storage: s });
      // ORDER BY req_id, role, issue_id, source_file, line → roles sort
      // alphabetically: amends-via < created < supersedes-via.
      expect(s.listProvenance().map((p) => [p.role, p.issue_id])).toEqual([
        ["amends-via", "ENG-2000"],
        ["created", "ENG-1432"],
        ["supersedes-via", "ENG-1781"],
      ]);
    } finally {
      s.close();
    }
  });
});
