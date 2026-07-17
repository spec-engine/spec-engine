// packages/engine/test/npm-package.test.ts
//
// The npm distribution contract (RED-101): the published package must ship
// only the built dist payload, its manifest must be installable by consumers
// (no workspace: protocol in published dependencies), and the bin entry must
// guard the Bun runtime BEFORE the bundle (with its static bun:sqlite
// import) is loaded. These are source/manifest assertions — the tarball
// rehearsal itself is `bun pm pack --dry-run` in the release loop.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { wrapperSource } from "../scripts/npm-wrapper";

const ENGINE_ROOT = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ENGINE_ROOT, "package.json"), "utf8")) as {
  name: string;
  private?: boolean;
  bin?: Record<string, string>;
  files?: string[];
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  license?: string;
  repository?: { url?: string };
};

describe("published manifest hygiene", () => {
  test("the engine publishes as @spec-engine/spec-engine and is not private", () => {
    expect(pkg.name).toBe("@spec-engine/spec-engine");
    expect(pkg.private).toBeUndefined();
  });

  test("only the dist payload ships (files whitelist + dist-anchored bin)", () => {
    expect(pkg.files).toEqual(["dist"]);
    expect(pkg.bin?.spec).toBe("./dist/cli.js");
  });

  test("published dependencies never carry the workspace: protocol", () => {
    // @spec DIST-004 unit
    // Workspace packages bundle into dist/impl.js at prepack; only registry
    // deps may appear in `dependencies`. (bun publish would rewrite a
    // workspace: version, but npm publish ships it verbatim and broken —
    // keeping the manifest clean makes the artifact publisher-agnostic.)
    const deps = pkg.dependencies ?? {};
    expect(Object.keys(deps).length).toBeGreaterThan(0);
    for (const [name, version] of Object.entries(deps)) {
      expect(name.startsWith("@spec-engine/")).toBe(false);
      expect(version.startsWith("workspace:")).toBe(false);
    }
  });

  test("prepack builds the payload; engines declares the Bun floor; license + repo set", () => {
    expect(pkg.scripts?.prepack).toContain("build:npm");
    expect(pkg.engines?.bun).toBeDefined();
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository?.url).toContain("github.com/spec-engine/spec-engine");
  });

  test("the package dir carries its own README and LICENSE (npm renders these)", () => {
    expect(existsSync(join(ENGINE_ROOT, "README.md"))).toBe(true);
    expect(existsSync(join(ENGINE_ROOT, "LICENSE"))).toBe(true);
  });
});

describe("bin wrapper runtime guard", () => {
  test("guard precedes the bundle import — Node dies with guidance, not ERR_UNKNOWN_BUILTIN_MODULE", () => {
    // @spec DIST-003 unit
    expect(wrapperSource.startsWith("#!/usr/bin/env bun\n")).toBe(true);
    const guardAt = wrapperSource.indexOf('typeof Bun === "undefined"');
    const importAt = wrapperSource.indexOf('await import("./impl.js")');
    expect(guardAt).toBeGreaterThan(0);
    expect(importAt).toBeGreaterThan(guardAt);
    // The import MUST be dynamic: a static `import` would hoist and resolve
    // bun:sqlite before the guard runs.
    expect(wrapperSource).not.toMatch(/^import /m);
    expect(wrapperSource).toContain("https://bun.sh");
    expect(wrapperSource).toContain("process.exit(1)");
  });
});
