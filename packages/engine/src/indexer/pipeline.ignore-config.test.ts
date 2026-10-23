// Tag lines are composed via src/testing/specTag.ts so this file's
// literals never index as claims of this repo.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../storage/sqlite";
import { TestPlatform } from "../testing/platform";
import { SPEC_TOKEN, specTag } from "../testing/specTag";
import { runIndex } from "./pipeline";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-ignore-config-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function buildPlatform(ignore?: string[]): Promise<string> {
  const platform = join(tmp, "platform");
  await TestPlatform.at(platform).member("api", { ignore });
  mkdirSync(join(platform, "spec-engine", "ORD"), { recursive: true });
  writeFileSync(
    join(platform, "spec-engine", "ORD", "SPEC.md"),
    "---\nkey: ORD\nspec_version: 1\n---\n\n### ORD-001 — Active\n" +
      "**Requirement:** r\n**Why it matters:** w\n**Binds:** \n**Lives in:** \n",
  );
  mkdirSync(join(platform, "api", "src"), { recursive: true });
  mkdirSync(join(platform, "api", "generated"), { recursive: true });
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

describe("per-repo ignore config", () => {
  test("baseline: without ignore, generated/ code and docs index normally", async () => {
    const platform = await buildPlatform();
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
    const platform = await buildPlatform(["generated"]);
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
    const platform = await buildPlatform(["generated/"]);
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
    const platform = await buildPlatform(["generated"]);
    await TestPlatform.at(platform).member("web");
    mkdirSync(join(platform, "web", "generated"), { recursive: true });
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

describe("extra ignore entries match as repo-relative prefixes", () => {
  let fx: TestPlatform;
  beforeEach(() => {
    fx = TestPlatform.temp("spec-ignore-prefix-");
  });
  afterEach(() => {
    fx.remove();
  });

  // @spec INDX-027 unit
  test("a package path or an ignore entry hides only the tree at the repo root", async () => {
    const [id] = (await (await fx.domain("ORD")).reqs(1)) as [string];
    const shop = await fx.member("shop", { ignore: ["vendor"] });
    shop.workspace(["apps/web"]);
    const tagged = `export const x = 1; ${specTag(id)}`;
    shop.file("modules/billing/tree/apps/web/x.ts", tagged);
    shop.file("src/vendor/x.ts", tagged);
    shop.file("vendor/x.ts", tagged);
    shop.file("apps/web/x.ts", tagged);
    const s = openStorage(join(fx.dir, ".spec-engine", "index.sqlite"));
    try {
      await runIndex({ platformDir: fx.dir, storage: s });
      expect(s.listTags().map((t) => `${t.repo} ${t.file}`)).toEqual([
        "shop shop/modules/billing/tree/apps/web/x.ts",
        "shop shop/src/vendor/x.ts",
        "shop/apps/web shop/apps/web/x.ts",
      ]);
    } finally {
      s.close();
    }
  });
});
