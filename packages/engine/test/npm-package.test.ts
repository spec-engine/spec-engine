// These are source/manifest assertions: the tarball rehearsal itself is
// `bun pm pack --dry-run` in the release loop.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { wrapperSource } from "../scripts/npm-wrapper";
import { agentPayload } from "../src/operations/agentSurface";

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

  test("published dependencies never carry the workspace: protocol", () => {
    // @spec DIST-023 unit
    // Workspace packages bundle into dist/impl.js at prepack; only registry
    // deps may appear in `dependencies`. (bun publish would rewrite a
    // workspace: version, but npm publish ships it verbatim and broken —
    // keeping the manifest clean makes the artifact publisher-agnostic.)
    // @spec-engine/platform-map is a registry package, pinned by version.
    const deps = pkg.dependencies ?? {};
    expect(Object.keys(deps).length).toBeGreaterThan(0);
    const workspacePackages = [
      "@spec-engine/shared",
      "@spec-engine/tracker",
      "@spec-engine/webapp",
    ];
    for (const [name, version] of Object.entries(deps)) {
      expect(workspacePackages).not.toContain(name);
      expect(version.startsWith("workspace:")).toBe(false);
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
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
    // @spec DIST-022 unit
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

describe("agent payload", () => {
  test("dist/agent carries the reference, the skill, the MCP template, and the hook template", () => {
    // @spec DIST-020 unit
    const payload = agentPayload();
    expect(Object.keys(payload).sort()).toEqual([
      "AGENTS.md",
      "mcp.json",
      "pre-commit",
      "skills/req-author/SKILL.md",
    ]);
    expect(payload["AGENTS.md"]?.startsWith("---")).toBe(false);
    expect(payload["skills/req-author/SKILL.md"]).toBe(
      readFileSync(resolve(ENGINE_ROOT, "../../.claude/skills/req-author/SKILL.md"), "utf8"),
    );
    expect(JSON.parse(payload["mcp.json"] ?? "")).toEqual({
      mcpServers: { spec: { command: "spec", args: ["mcp", "."] } },
    });
    expect(payload["pre-commit"]).toBe("#!/bin/sh\nspec guard .\nexit $?\n");
  });
});
