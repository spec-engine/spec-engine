// packages/engine/test/ignore-config.test.ts
//
// Audit hygiene pass T7 — per-repo `ignore` field in spec-engine.member.json.
// Entries are repo-relative directory prefixes layered ON TOP of the
// hardcoded IGNORE_SUBSTR list (additive only — a repo can exclude its own
// generated trees, never re-include `fixtures/`). The field is a
// discovery-time hint like Repo.selfMember: it shapes the scan, it is
// never persisted to the repos table.
//
// Tag lines are composed via test/fixtures/specTag.ts so this file's
// literals can never index as phantom claims of THIS repo (dogfood rule).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";
import { SPEC_TOKEN, specTag } from "./fixtures/specTag";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-ignore-config-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Minimal platform: canonical ORD-001 + one member `api` with a tagged
 *  src file, a tagged file under `generated/`, and a doc binding under
 *  `generated/`. `ignore` lands in api/spec-engine.member.json when given. */
function buildPlatform(ignore?: string[]): string {
  const platform = join(tmp, "platform");
  mkdirSync(join(platform, "spec-engine", "ORD"), { recursive: true });
  writeFileSync(
    join(platform, "spec-engine", "ORD", "SPEC.md"),
    "---\nkey: ORD\nspec_version: 1\n---\n\n### ORD-001 — Active\n" +
      "**Requirement:** r\n**Why it matters:** w\n**Binds:** \n**Lives in:** \n",
  );
  mkdirSync(join(platform, "api", "src"), { recursive: true });
  mkdirSync(join(platform, "api", "generated"), { recursive: true });
  const config: Record<string, unknown> = { specs: "spec-engine@1" };
  if (ignore) config.ignore = ignore;
  writeFileSync(join(platform, "api", "spec-engine.member.json"), `${JSON.stringify(config)}\n`);
  writeFileSync(join(platform, "api", "src", "a.ts"), `export const a = 1; ${specTag("ORD-001")}`);
  writeFileSync(
    join(platform, "api", "generated", "b.ts"),
    `export const b = 1; ${specTag("ORD-001")}`,
  );
  writeFileSync(
    join(platform, "api", "generated", "notes.md"),
    `docs line <!-- ${SPEC_TOKEN} ORD-001 -->\n`,
  );
  return platform;
}

describe("per-repo ignore config (T7)", () => {
  test("baseline: without ignore, generated/ code and docs index normally", async () => {
    const platform = buildPlatform();
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: platform, storage: s });
      const files = s.listTags({ repo: "api" }).map((t) => t.file);
      expect(files).toContain("api/src/a.ts");
      expect(files).toContain("api/generated/b.ts");
      expect(files).toContain("api/generated/notes.md");
    } finally {
      s.close();
    }
  });

  test('ignore: ["generated"] excludes the subtree from code AND doc scans', async () => {
    const platform = buildPlatform(["generated"]);
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: platform, storage: s });
      const files = s.listTags({ repo: "api" }).map((t) => t.file);
      expect(files).toContain("api/src/a.ts");
      expect(files).not.toContain("api/generated/b.ts");
      expect(files).not.toContain("api/generated/notes.md");
    } finally {
      s.close();
    }
  });

  test("trailing-slash entries behave identically to bare names", async () => {
    const platform = buildPlatform(["generated/"]);
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: platform, storage: s });
      const files = s.listTags({ repo: "api" }).map((t) => t.file);
      expect(files).toEqual(["api/src/a.ts"]);
    } finally {
      s.close();
    }
  });

  test("ignore in one repo does not leak into sibling members", async () => {
    const platform = buildPlatform(["generated"]);
    // Second member with the SAME layout but no ignore field.
    mkdirSync(join(platform, "web", "generated"), { recursive: true });
    writeFileSync(
      join(platform, "web", "spec-engine.member.json"),
      '{ "specs": "spec-engine@1" }\n',
    );
    writeFileSync(
      join(platform, "web", "generated", "c.ts"),
      `export const c = 1; ${specTag("ORD-001")}`,
    );
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: platform, storage: s });
      const files = s.listTags().map((t) => t.file);
      expect(files).not.toContain("api/generated/b.ts");
      expect(files).toContain("web/generated/c.ts");
    } finally {
      s.close();
    }
  });
});
