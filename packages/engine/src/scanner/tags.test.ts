// @spec INDX-024 unit
// @spec INDX-028 unit
// @spec INDX-025 unit

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Literal `@spec <ID>` pairs in this source would index as dangling tags of
// this repo, so they are composed at runtime.
import { SPEC_TOKEN, specTag } from "../testing/specTag";
import { findCodeFiles, IGNORE_SUBSTR, isPathIgnored } from "./fs";
import { isTestFile, LEVELS, SPEC_TAG_RE, scanTagsInFile, TEST_MATCH } from "./tags";

const SCANNER_FIXTURES = join(import.meta.dir, "..", "testing", "fixtures", "scanner");
const API_FIXTURE = join(SCANNER_FIXTURES, "api");

describe("findCodeFiles", () => {
  test("returns only the src + test files under api/, filters node_modules/ and dist/", async () => {
    const out = await findCodeFiles(API_FIXTURE);
    expect(out).toEqual(["src/sample.ts", "test/sample.test.ts"]);
  });

  test("output is lexicographically sorted", async () => {
    const out = await findCodeFiles(API_FIXTURE);
    expect(out).toEqual([...out].sort());
  });

  test("10× invocation is byte-identical", async () => {
    const first = await findCodeFiles(API_FIXTURE);
    for (let i = 0; i < 9; i++) {
      const next = await findCodeFiles(API_FIXTURE);
      expect(next).toEqual(first);
    }
  });

  test("default ext set rejects .md / .json", async () => {
    let tmp: string | null = null;
    try {
      tmp = mkdtempSync(join(tmpdir(), "spec-scanner-ext-"));
      writeFileSync(join(tmp, "README.md"), "# do not match");
      writeFileSync(join(tmp, "package.json"), "{}");
      writeFileSync(join(tmp, "code.ts"), specTag("X-001"));
      const out = await findCodeFiles(tmp);
      expect(out).toEqual(["code.ts"]);
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("extraIgnore=['spec-engine/'] excludes the in-repo canonical dir", async () => {
    let tmp: string | null = null;
    try {
      tmp = mkdtempSync(join(tmpdir(), "spec-scanner-extra-ignore-"));
      mkdirSync(join(tmp, "spec-engine", "ORDERS"), { recursive: true });
      mkdirSync(join(tmp, "src"), { recursive: true });
      writeFileSync(join(tmp, "spec-engine", "x.ts"), specTag("ORDERS-001"));
      writeFileSync(join(tmp, "src", "a.ts"), specTag("ORDERS-001"));

      const out = await findCodeFiles(tmp, ["ts", "tsx", "js", "jsx", "mjs"], ["spec-engine/"]);
      expect(out).toEqual(["src/a.ts"]);
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an omitted extraIgnore matches an explicit empty list", async () => {
    const twoArg = await findCodeFiles(API_FIXTURE);
    const explicitEmpty = await findCodeFiles(API_FIXTURE, ["ts", "tsx", "js", "jsx", "mjs"], []);
    expect(twoArg).toEqual(["src/sample.ts", "test/sample.test.ts"]);
    expect(explicitEmpty).toEqual(twoArg);
  });

  test("fixtures/ subtrees are ignored at any depth", async () => {
    let tmp: string | null = null;
    try {
      tmp = mkdtempSync(join(tmpdir(), "spec-scanner-fixtures-ignore-"));
      mkdirSync(join(tmp, "src"), { recursive: true });
      mkdirSync(join(tmp, "fixtures", "planted"), { recursive: true });
      mkdirSync(join(tmp, "test", "fixtures"), { recursive: true });
      writeFileSync(join(tmp, "src", "a.ts"), "export const a = 1;\n");
      writeFileSync(join(tmp, "fixtures", "planted", "bait.ts"), "export const b = 2;\n");
      writeFileSync(join(tmp, "test", "fixtures", "deep-bait.ts"), "export const c = 3;\n");
      const out = await findCodeFiles(tmp);
      expect(out).toEqual(["src/a.ts"]);
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a sibling dir like src/mydist/ is NOT ignored (only real dist/)", async () => {
    let tmp: string | null = null;
    try {
      tmp = mkdtempSync(join(tmpdir(), "spec-scanner-anchor-"));
      mkdirSync(join(tmp, "src", "mydist"), { recursive: true });
      mkdirSync(join(tmp, "src", "dist"), { recursive: true });
      mkdirSync(join(tmp, "buildings"), { recursive: true }); // substring of "build"
      writeFileSync(join(tmp, "src", "mydist", "keep.ts"), "export const a = 1;\n");
      writeFileSync(join(tmp, "src", "dist", "skip.ts"), "export const b = 2;\n");
      writeFileSync(join(tmp, "buildings", "keep.ts"), "export const c = 3;\n");
      const out = await findCodeFiles(tmp);
      expect(out).toEqual(["buildings/keep.ts", "src/mydist/keep.ts"]);
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("isPathIgnored anchors to segment boundaries", () => {
    expect(isPathIgnored("node_modules/pkg/index.ts")).toBe(true);
    expect(isPathIgnored("src/dist/out.js")).toBe(true);
    expect(isPathIgnored("a/b/fixtures/planted.ts")).toBe(true);
    expect(isPathIgnored("src/mydist/out.ts")).toBe(false);
    expect(isPathIgnored("buildings/a.ts")).toBe(false);
    expect(isPathIgnored("src/renew.ts")).toBe(false);
  });

  // @spec INDX-027 unit
  test("an extra token matches only as a repo-relative prefix", () => {
    expect(isPathIgnored("generated/x.ts", ["generated"])).toBe(true);
    expect(isPathIgnored("generated/x.ts", ["generated/"])).toBe(true);
    expect(isPathIgnored("apps/web/x.ts", ["apps/web"])).toBe(true);
    expect(isPathIgnored("a/generated/x.ts", ["generated"])).toBe(false);
    expect(isPathIgnored("modules/billing/tree/apps/web/x.ts", ["apps/web"])).toBe(false);
    expect(isPathIgnored("generatedx/x.ts", ["generated"])).toBe(false);
  });

  test("IGNORE_SUBSTR includes the standard denylist plus dot-dir cousins", () => {
    expect([...IGNORE_SUBSTR]).toEqual([
      "node_modules/",
      ".git/",
      ".spec-engine/",
      ".factory/",
      ".next/",
      ".turbo/",
      ".cache/",
      "dist/",
      "build/",
      "coverage/",
      "fixtures/",
    ]);
  });
});

describe("isTestFile", () => {
  test.each<[string, boolean]>([
    ["api/test/renew.test.ts", true],
    ["api/test/renew.e2e.test.ts", true],
    ["api/src/renew.ts", false],
    ["api/__tests__/renew.ts", true],
    ["api/tests/renew.ts", true],
    ["api/e2e/renew.ts", true],
    ["api/src/foo.spec.ts", true],
    // "src/test.ts" — single token doesn't match `.test.` (needs both dots)
    ["api/src/test.ts", false],
    // @spec INDX-025 unit
    ["api/renew_test.go", true],
    ["api/renew.go", false],
    ["api/tests/renew.rs", true],
    ["api/src/renew_test.rs", true],
    ["api/src/renew.rs", false],
    ["api/spec/renew_spec.lua", true],
    ["api/src/renew_spec.lua", true],
    ["api/src/renew_test.lua", true],
    ["api/src/renew.spec.lua", true],
    ["api/src/renew.spec.luau", true],
    ["api/src/renew.test.luau", true],
    ["api/src/renew.lua", false],
    ["api/src/renew.luau", false],
  ])("isTestFile(%p) === %p", (path, expected) => {
    expect(isTestFile(path)).toBe(expected);
  });

  test("TEST_MATCH lists the six canonical substrings and the Go, Rust, and Lua conventions", () => {
    expect([...TEST_MATCH]).toEqual([
      ".test.",
      ".spec.",
      "__tests__/",
      "/tests/",
      "/e2e/",
      ".e2e.",
      "_test.go",
      "_test.rs",
      "_spec.lua",
      "_test.lua",
      "/spec/",
    ]);
  });
});

describe("scanTagsInFile", () => {
  test("happy path: src file with 2 @spec lines → 2 implements tags", () => {
    const text = `${specTag("BILLING-009")}const x = 1;\n${specTag("BILLING-002", "unit")}`;
    const hits = scanTagsInFile("api", "api/src/renew.ts", text);
    expect(hits).toEqual([
      {
        req_id: "BILLING-009",
        repo: "api",
        file: "api/src/renew.ts",
        line: 1,
        kind: "implements",
        level: null,
      },
      {
        req_id: "BILLING-002",
        repo: "api",
        file: "api/src/renew.ts",
        line: 3,
        kind: "implements",
        // level is path-INDEPENDENT — annotation wins even on src/
        level: "unit",
      },
    ]);
  });

  test("test file: kind=verifies, level=e2e from explicit annotation", () => {
    const text = specTag("BILLING-009", "e2e").trimEnd();
    const hits = scanTagsInFile("api", "api/test/renew.test.ts", text);
    expect(hits).toEqual([
      {
        req_id: "BILLING-009",
        repo: "api",
        file: "api/test/renew.test.ts",
        line: 1,
        kind: "verifies",
        level: "e2e",
      },
    ]);
  });

  test("multiple @spec tags across separate lines yield separate rows", () => {
    const text = `${specTag("BILLING-007")}${specTag("BILLING-999")}`;
    const hits = scanTagsInFile("admin", "admin/src/reports.ts", text);
    expect(hits).toEqual([
      {
        req_id: "BILLING-007",
        repo: "admin",
        file: "admin/src/reports.ts",
        line: 1,
        kind: "implements",
        level: null,
      },
      {
        req_id: "BILLING-999",
        repo: "admin",
        file: "admin/src/reports.ts",
        line: 2,
        kind: "implements",
        level: null,
      },
    ]);
  });

  test("multiple @spec on a single line → multiple tags at the same line number", () => {
    const text = `// ${SPEC_TOKEN} X-001 ${SPEC_TOKEN} X-002`;
    const hits = scanTagsInFile("api", "api/src/multi.ts", text);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      req_id: "X-001",
      repo: "api",
      file: "api/src/multi.ts",
      line: 1,
      kind: "implements",
      level: null,
    });
    expect(hits[1]).toEqual({
      req_id: "X-002",
      repo: "api",
      file: "api/src/multi.ts",
      line: 1,
      kind: "implements",
      level: null,
    });
  });

  test("unknown level token (huge / slow) → level: null (LEVELS rejection)", () => {
    const text = `${specTag("X-001", "huge")}${specTag("X-002", "slow")}`;
    const hits = scanTagsInFile("api", "api/src/levels.ts", text);
    expect(hits[0]?.level).toBeNull();
    expect(hits[1]?.level).toBeNull();
  });

  test("level token integration is recognized on test files", () => {
    const text = specTag("X-001", "integration").trimEnd();
    const hits = scanTagsInFile("admin", "admin/test/reports.int.test.ts", text);
    expect(hits[0]?.level).toBe("integration");
    expect(hits[0]?.kind).toBe("verifies");
  });

  test("comment style is irrelevant — block comments, hashes, string literals all match", () => {
    const text = `/* ${SPEC_TOKEN} X-001 */\n# ${SPEC_TOKEN} X-002\n"${SPEC_TOKEN} X-003"\n`;
    const hits = scanTagsInFile("api", "api/src/styles.ts", text);
    expect(hits.map((h) => h.req_id)).toEqual(["X-001", "X-002", "X-003"]);
  });

  test("returns [] for files with no @spec tags", () => {
    expect(scanTagsInFile("api", "api/src/empty.ts", "const x = 1;\n")).toEqual([]);
  });

  test("LEVELS exports exactly { unit, integration, e2e }", () => {
    expect([...LEVELS].sort()).toEqual(["e2e", "integration", "unit"]);
  });

  test("SPEC_TAG_RE carries the global flag (caller relies on lastIndex semantics)", () => {
    expect(SPEC_TAG_RE.flags).toContain("g");
  });
});
