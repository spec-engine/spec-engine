// @spec INDX-019 unit
// @spec INDX-015

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runIndex } from "../indexer/pipeline";
import { openStorage } from "../storage/sqlite";
import { TestPlatform } from "../testing/platform";
import { SPEC_TOKEN, specTag } from "../testing/specTag";
import { DEFAULT_EXTS, findCodeFiles, isTagSource } from "./fs";

let fx: TestPlatform;

beforeEach(() => {
  fx = TestPlatform.temp("spec-scan-languages-");
});

afterEach(() => {
  fx.remove();
});

const lua = (id: string, level?: string): string =>
  `local x = 1 -- ${SPEC_TOKEN} ${id}${level ? ` ${level}` : ""}\n`;
const slash = (id: string, level?: string): string => `${specTag(id, level)}\nfn main() {}\n`;

describe("the scanner reads every listed source kind", () => {
  test("DEFAULT_EXTS names every scanned extension", () => {
    expect([...DEFAULT_EXTS]).toEqual([
      "ts",
      "tsx",
      "js",
      "jsx",
      "mjs",
      "sh",
      "lua",
      "luau",
      "go",
      "rs",
      "tf",
      "toml",
      "sql",
      "css",
    ]);
  });

  test("findCodeFiles returns the listed extensions and Dockerfiles, and skips the rest", async () => {
    const api = await fx.member("api", {
      files: {
        "src/a.lua": "",
        "src/b.luau": "",
        "src/c.go": "",
        "src/d.rs": "",
        "src/e.py": "",
        "src/f.toml": "",
        "infra/main.tf": "",
        "db/001.sql": "",
        "web/app.css": "",
        Dockerfile: "",
        "ops/Dockerfile.dev": "",
        "ops/Dockerfile.": "",
        "ops/Dockerfiles": "",
        "ops.d/README": "",
      },
    });
    expect(await findCodeFiles(api.dir)).toEqual([
      "Dockerfile",
      "db/001.sql",
      "infra/main.tf",
      "ops/Dockerfile.dev",
      "src/a.lua",
      "src/b.luau",
      "src/c.go",
      "src/d.rs",
      "src/f.toml",
      "web/app.css",
    ]);
  });

  test("a hash, double-dash, or block-comment tag in the new kinds indexes as implements", async () => {
    const billing = await fx.domain("BILLING");
    const ids = (await billing.reqs(6)) as [string, string, string, string, string, string];
    const [tf, toml, docker, dockerDev, sql, css] = ids;
    await fx.member("api", {
      files: {
        "infra/main.tf": `resource "x" "y" {} # ${SPEC_TOKEN} ${tf}\n`,
        "Cargo.toml": `[package] # ${SPEC_TOKEN} ${toml}\n`,
        Dockerfile: `FROM scratch\n# ${SPEC_TOKEN} ${docker}\n`,
        "ops/Dockerfile.dev": `# ${SPEC_TOKEN} ${dockerDev}\nFROM scratch\n`,
        "db/001.sql": `-- ${SPEC_TOKEN} ${sql}\nSELECT 1;\n`,
        "web/app.css": `/* ${SPEC_TOKEN} ${css} */\nbody {}\n`,
      },
    });
    const s = openStorage(join(fx.dir, ".spec-engine", "index.sqlite"));
    try {
      await runIndex({ platformDir: fx.dir, storage: s });
      const kinds = Object.fromEntries(s.listTags().map((t) => [t.req_id, t.kind]));
      expect(kinds).toEqual(Object.fromEntries(ids.map((id) => [id, "implements"])));
    } finally {
      s.close();
    }
  });

  test("tags in each language index with the kind its test convention decides", async () => {
    const billing = await fx.domain("BILLING");
    const [goId, rsId, luaId, luauId] = (await billing.reqs(4)) as [string, string, string, string];
    await fx.member("api", {
      files: {
        "renew.go": slash(goId),
        "renew_test.go": slash(goId, "unit"),
        "src/renew.rs": slash(rsId),
        "tests/renew.rs": slash(rsId, "integration"),
        "src/renew_test.rs": slash(rsId, "unit"),
        "src/renew.lua": lua(luaId),
        "spec/renew_spec.lua": lua(luaId, "unit"),
        "src/renew_test.lua": lua(luaId),
        "src/Renew.luau": lua(luauId),
        "src/Renew.spec.luau": lua(luauId, "unit"),
        "src/Renew.test.luau": lua(luauId),
      },
    });
    const s = openStorage(join(fx.dir, ".spec-engine", "index.sqlite"));
    try {
      const result = await runIndex({ platformDir: fx.dir, storage: s });
      expect(result.tags).toBe(11);
      const kinds = Object.fromEntries(
        s.listTags().map((t) => [t.file, `${t.kind}${t.level ? `:${t.level}` : ""}`]),
      );
      expect(kinds).toEqual({
        "api/renew.go": "implements",
        "api/renew_test.go": "verifies:unit",
        "api/src/renew.rs": "implements",
        "api/tests/renew.rs": "verifies:integration",
        "api/src/renew_test.rs": "verifies:unit",
        "api/src/renew.lua": "implements",
        "api/spec/renew_spec.lua": "verifies:unit",
        "api/src/renew_test.lua": "verifies",
        "api/src/Renew.luau": "implements",
        "api/src/Renew.spec.luau": "verifies:unit",
        "api/src/Renew.test.luau": "verifies",
      });
      const covered = s.coverageMatrix().filter((r) => r.repo === "api");
      expect(covered.map((r) => [r.req_id, r.implemented, r.verified])).toEqual([
        [goId, 1, 1],
        [rsId, 1, 1],
        [luaId, 1, 1],
        [luauId, 1, 1],
      ]);
    } finally {
      s.close();
    }
  });
});

describe("isTagSource", () => {
  // @spec INDX-019 unit
  test("accepts every DEFAULT_EXTS file and a Dockerfile, rejects docs and extensionless files", () => {
    for (const ext of DEFAULT_EXTS) expect(isTagSource(`deep/dir/x.${ext}`)).toBe(true);
    expect(isTagSource("infra/Dockerfile")).toBe(true);
    expect(isTagSource("infra/Dockerfile.dev")).toBe(true);
    expect(isTagSource("README.md")).toBe(false);
    expect(isTagSource("bin/run")).toBe(false);
    expect(isTagSource("dir.x/Makefile")).toBe(false);
  });
});
