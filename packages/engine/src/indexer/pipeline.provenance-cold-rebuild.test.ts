import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../storage/sqlite";
import { entryOf, plantEdit } from "../testing/plant";
import { TestPlatform } from "../testing/platform";
import { specTag } from "../testing/specTag";
import { runIndex } from "./pipeline";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-prov-cold-rebuild-"));
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

/**
 * `issuesLine` order is written into `issues[]` as given, so any order
 * independence in build_id comes from the pipeline, not this writer.
 */
async function buildFixture(dir: string, issuesLine: string | null): Promise<string> {
  const issues =
    issuesLine === null
      ? []
      : issuesLine.split(",").map((tok) => {
          const [role, id] = tok.trim().split(":");
          return { role: role as string, id: (id ?? "") as string };
        });
  // The same dir is rebuilt with a reordered issues line, so the platform is
  // authored once and only the planted issues change on a second call.
  const fx = TestPlatform.at(dir);
  if (!existsSync(fx.specFile("PROV"))) {
    const prov = await fx.domain("PROV", { owner: "drea" });
    const { id } = await prov.req({
      statement: "The renewal charge is computed at charge time per region.",
      why: "Compliance.",
    });
    await fx.member("api", {
      pin: "spec-engine@2",
      files: { "src/renew.ts": `${specTag(id)}export const renew = () => 0;\n` },
    });
  }
  // An authoring command records one issue at a time; the ordered multi-role
  // list this test reorders is planted onto the entry.
  await plantEdit(dir, "PROV", (doc) => {
    entryOf(doc, "PROV-001").issues = issues;
  });
  return dir;
}

async function indexBuildId(platformDir: string, dbPath: string): Promise<string> {
  const s = openStorage(dbPath);
  try {
    const r = await runIndex({ platformDir, storage: s });
    return r.build_id;
  } finally {
    s.close();
  }
}

describe("provenance cold-rebuild + token-reorder", () => {
  test("byte-identity: warm == cold == three-run on a multi-issue Issues line", async () => {
    const fixture = await buildFixture(
      join(tmp, "fixture"),
      "created:ENG-1432, supersedes-via:ENG-1781, amends-via:ENG-2000",
    );
    const dbPath = join(tmp, "index.sqlite");

    const s1 = openStorage(dbPath);
    const a = await runIndex({ platformDir: fixture, storage: s1 });
    const b = await runIndex({ platformDir: fixture, storage: s1 });
    s1.close();

    removeDbAndWalSiblings(dbPath);
    expect(existsSync(dbPath)).toBe(false);
    const s2 = openStorage(dbPath);
    const c = await runIndex({ platformDir: fixture, storage: s2 });
    s2.close();

    expect(a.build_id).toMatch(/^[0-9a-f]{64}$/);
    expect(a.build_id).toBe(b.build_id);
    expect(a.build_id).toBe(c.build_id);
    expect(b.build_id).toBe(c.build_id);
  });

  test("token-reorder: authored Issues order is irrelevant to build_id", async () => {
    // Both variants must share one platform dir: repos.path (absolute) is
    // hashed into build_id, so separate dirs would differ for an unrelated
    // reason.
    const platformDir = join(tmp, "fixture");

    await buildFixture(
      platformDir,
      "created:ENG-1432, supersedes-via:ENG-1781, amends-via:ENG-2000",
    );
    const h1 = await indexBuildId(platformDir, join(tmp, "canonical.sqlite"));

    await buildFixture(
      platformDir,
      "supersedes-via:ENG-1781, amends-via:ENG-2000, created:ENG-1432",
    );
    const h2 = await indexBuildId(platformDir, join(tmp, "reordered.sqlite"));

    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h2).toBe(h1);
  });

  test("a different issue set changes build_id", async () => {
    // Same platform dir, so the only varying byte is an issue id.
    const platformDir = join(tmp, "fixture");

    await buildFixture(platformDir, "created:ENG-1432, supersedes-via:ENG-1781");
    const hBase = await indexBuildId(platformDir, join(tmp, "base.sqlite"));

    await buildFixture(platformDir, "created:ENG-1432, supersedes-via:ENG-9999");
    const hAltered = await indexBuildId(platformDir, join(tmp, "altered.sqlite"));

    expect(hAltered).not.toBe(hBase);
    expect(hAltered).toMatch(/^[0-9a-f]{64}$/);
  });

  test("no issues: zero provenance rows + build_id stable across cold rebuild", async () => {
    const fixture = await buildFixture(join(tmp, "no-issues"), null);
    const dbPath = join(tmp, "no-issues.sqlite");

    const s1 = openStorage(dbPath);
    const a = await runIndex({ platformDir: fixture, storage: s1 });
    expect(s1.listProvenance()).toEqual([]);
    s1.close();

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
