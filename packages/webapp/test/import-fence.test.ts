// @spec SCHM-012
//
// A second fence behind Biome's `noRestrictedImports` in
// `packages/webapp/biome.json`: it still fails if the rule is disabled, the
// override deleted, or an import slips past it in a shape the lint does not
// parse. Co-located tests and `src/testing/` are skipped: they import the
// engine for harness use, and the Biome override does not cover them either.

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const WEBAPP_ROOT = resolve(import.meta.dir, "..");

/** Each `node:<mod>` alternative must allow a `/...` subpath, or
 *  `node:fs/promises` and `node:path/posix` slip through. */
const FORBIDDEN_RE =
  /from\s+["'](bun:sqlite|node:fs(?:\/[^"']*)?|fs(?:\/[^"']*)?|bun|node:path(?:\/[^"']*)?|node:os(?:\/[^"']*)?|node:crypto(?:\/[^"']*)?|node:child_process(?:\/[^"']*)?|node:net(?:\/[^"']*)?|node:http(?:\/[^"']*)?|@spec-engine\/spec-engine(?:\/[^"']*)?|@spec-engine\/tracker(?:\/[^"']*)?)["']/;

/** Biome's static-import rule does not see dynamic `import("…")` calls. */
const DYNAMIC_IMPORT_RE =
  /import\s*\(\s*["'](bun:sqlite|node:fs(?:\/[^"']*)?|fs(?:\/[^"']*)?|bun|node:path(?:\/[^"']*)?|node:os(?:\/[^"']*)?|node:crypto(?:\/[^"']*)?|node:child_process(?:\/[^"']*)?|node:net(?:\/[^"']*)?|node:http(?:\/[^"']*)?|@spec-engine\/spec-engine(?:\/[^"']*)?|@spec-engine\/tracker(?:\/[^"']*)?)["']\s*\)/;

describe("webapp import fence", () => {
  test("packages/webapp/src/**/*.ts contains no forbidden imports", async () => {
    const glob = new Bun.Glob("src/**/*.ts");
    const offenders: Array<{ file: string; line: number; match: string }> = [];

    for await (const rel of glob.scan({ cwd: WEBAPP_ROOT })) {
      if (rel.endsWith(".test.ts") || rel.startsWith("src/testing/")) continue;
      const abs = join(WEBAPP_ROOT, rel);
      const src = await Bun.file(abs).text();
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const m = line.match(FORBIDDEN_RE) ?? line.match(DYNAMIC_IMPORT_RE);
        if (m) offenders.push({ file: rel, line: i + 1, match: m[1] ?? "" });
      }
    }

    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  ${o.file}:${o.line} — ${o.match}`).join("\n");
      throw new Error(
        `Webapp source imports a forbidden module:\n${detail}\n` +
          "Allowed: @spec-engine/shared (types) + hono (runtime). Move runtime/file-access " +
          "code to the engine package and consume it via /api/* over Hono app.request.",
      );
    }

    expect(offenders.length).toBe(0);
  });

  test("the fence regexes match the current package names", () => {
    // A regex naming a stale package matches nothing and passes vacuously, so
    // a package rename must break this test instead of neutering the fence.
    const offendingStatic = [
      'import { runIndex } from "@spec-engine/spec-engine";',
      "import { openStorage } from '@spec-engine/spec-engine/storage';",
      'import { resolveIssues } from "@spec-engine/tracker";',
      'import { readFileSync } from "node:fs";',
      'import { Database } from "bun:sqlite";',
    ];
    for (const line of offendingStatic) {
      expect(line).toMatch(FORBIDDEN_RE);
    }

    const offendingDynamic = [
      'const e = await import("@spec-engine/spec-engine");',
      "const t = await import('@spec-engine/tracker/linear');",
    ];
    for (const line of offendingDynamic) {
      expect(line).toMatch(DYNAMIC_IMPORT_RE);
    }

    for (const allowed of [
      'import { validateAndWrite } from "@spec-engine/shared";',
      'import { html } from "hono/html";',
    ]) {
      expect(allowed).not.toMatch(FORBIDDEN_RE);
      expect(allowed).not.toMatch(DYNAMIC_IMPORT_RE);
    }
  });

  test("scan reaches the SSR page modules and server.ts", async () => {
    // A glob that silently matches nothing would let the fence above pass.
    const glob = new Bun.Glob("src/**/*.ts");
    const found = new Set<string>();
    for await (const rel of glob.scan({ cwd: WEBAPP_ROOT })) {
      if (rel.endsWith(".test.ts") || rel.startsWith("src/testing/")) continue;
      found.add(rel);
    }
    for (const expected of [
      "src/server.ts",
      "src/pages/coverage.ts",
      "src/pages/requirements.ts",
      "src/pages/propagation.ts",
      "src/pages/query.ts",
      "src/pages/provenance.ts",
      "src/pages/editor.ts",
    ]) {
      expect(found.has(expected)).toBe(true);
    }
  });
});
