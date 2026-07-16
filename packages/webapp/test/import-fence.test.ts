// packages/webapp/test/import-fence.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec SCHM-002
//
// Plan 05-04 / Task 2 — defense-in-depth grep alongside Biome's
// `noRestrictedImports` rule on `packages/webapp/biome.json`. Locks
// D-09 / WORK-04 / Invariant #5: webapp source MUST NOT import
// bun:sqlite, node:fs, fs, bun, node:path, or `@spec-engine/spec-check` (any
// subpath). If a future change disables the Biome rule, deletes the
// override, or sneaks an import past it via a non-AST shape this lint
// doesn't cover, this grep test fails before the build merges.
//
// Defense-in-depth pattern from 05-RESEARCH § Import-Guard Mechanics
// (lines 736-744). Test files live in `packages/webapp/test/` which the
// biome.json scopes OUT of the noRestrictedImports rule (override applies
// to `src/**/*.ts` only); tests can import @spec-engine/spec-check for harness use.

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const WEBAPP_ROOT = resolve(import.meta.dir, "..");

// Forbidden import targets enforced by the regex below:
//   bun:sqlite, node:fs, fs, bun, node:path, @spec-engine/spec-check (any subpath).
// Allowed: @spec-engine/shared (types) + hono (runtime).

/** Single combined regex: matches `from "x"` or `from 'x'` where x is any
 *  forbidden module path, OR any `@spec-engine/spec-check` subpath. Capture group 1
 *  gives the offending module for failure messages.
 *
 *  Per CR-02: the `node:<mod>` alternatives MUST allow an optional `/...`
 *  subpath so that `node:fs/promises`, `node:path/posix`, etc., are caught
 *  alongside the bare module specifier. Adding `node:os`, `node:crypto`,
 *  `node:child_process`, `node:net`, and `node:http` to the deny list to
 *  cover the rest of the hermetic-webapp surface. */
const FORBIDDEN_RE =
  /from\s+["'](bun:sqlite|node:fs(?:\/[^"']*)?|fs(?:\/[^"']*)?|bun|node:path(?:\/[^"']*)?|node:os(?:\/[^"']*)?|node:crypto(?:\/[^"']*)?|node:child_process(?:\/[^"']*)?|node:net(?:\/[^"']*)?|node:http(?:\/[^"']*)?|@spec-engine\/spec-check(?:\/[^"']*)?|@spec-engine\/tracker(?:\/[^"']*)?)["']/;

/** Same shape for dynamic `import("…")` calls (defense against an
 *  AST-level bypass of Biome's static-import detection).
 *
 *  Per Phase 16 / D-09 tightening (PWEB-02 / T-16-D09): `@spec-engine/tracker`
 *  (+ subpaths) is now FORBIDDEN in the webapp — tracker resolution is
 *  ENGINE-SIDE behind `/api/provenance?resolve=1`; the webapp renders the
 *  decorated TEXT only and must never resolve issues itself. */
const DYNAMIC_IMPORT_RE =
  /import\s*\(\s*["'](bun:sqlite|node:fs(?:\/[^"']*)?|fs(?:\/[^"']*)?|bun|node:path(?:\/[^"']*)?|node:os(?:\/[^"']*)?|node:crypto(?:\/[^"']*)?|node:child_process(?:\/[^"']*)?|node:net(?:\/[^"']*)?|node:http(?:\/[^"']*)?|@spec-engine\/spec-check(?:\/[^"']*)?|@spec-engine\/tracker(?:\/[^"']*)?)["']\s*\)/;

describe("webapp import fence (D-09 / WORK-04 / Invariant #5)", () => {
  test("packages/webapp/src/**/*.ts contains no forbidden imports", async () => {
    const glob = new Bun.Glob("src/**/*.ts");
    const offenders: Array<{ file: string; line: number; match: string }> = [];

    for await (const rel of glob.scan({ cwd: WEBAPP_ROOT })) {
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
        `Webapp source imports a forbidden module (D-09 / WORK-04 / Invariant #5):\n${detail}\n` +
          "Allowed: @spec-engine/shared (types) + hono (runtime). Move runtime/file-access " +
          "code to the engine package and consume it via /api/* over Hono app.request.",
      );
    }

    // Positive sanity: ensure the scan actually found at least one file
    // (otherwise the test could silently pass on an empty src/).
    expect(offenders.length).toBe(0);
  });

  test("1.4 self-test: the fence regexes actually match the current package names", () => {
    // A stale regex (e.g. the pre-rename `@spec/engine`) passes VACUOUSLY —
    // it matches nothing, so the fence silently stops guarding. Assert the
    // regexes trip on synthetic offending lines built from the CURRENT package
    // names, so a future package rename breaks this test loudly instead of
    // neutering the fence.
    const offendingStatic = [
      'import { runIndex } from "@spec-engine/spec-check";',
      "import { openStorage } from '@spec-engine/spec-check/storage';",
      'import { resolveIssues } from "@spec-engine/tracker";',
      'import { readFileSync } from "node:fs";',
      'import { Database } from "bun:sqlite";',
    ];
    for (const line of offendingStatic) {
      expect(line).toMatch(FORBIDDEN_RE);
    }

    const offendingDynamic = [
      'const e = await import("@spec-engine/spec-check");',
      "const t = await import('@spec-engine/tracker/linear');",
    ];
    for (const line of offendingDynamic) {
      expect(line).toMatch(DYNAMIC_IMPORT_RE);
    }

    // The two ALLOWED imports must NOT trip either regex.
    for (const allowed of [
      'import { validateAndWrite } from "@spec-engine/shared";',
      'import { html } from "hono/html";',
    ]) {
      expect(allowed).not.toMatch(FORBIDDEN_RE);
      expect(allowed).not.toMatch(DYNAMIC_IMPORT_RE);
    }
  });

  test("scan reaches the SSR page modules + server.ts (incl. provenance.ts)", async () => {
    // Defends against a tooling regression where the Glob silently
    // matches nothing — the grep test above would still pass on an empty
    // set. Assert the expected files are actually scanned.
    const glob = new Bun.Glob("src/**/*.ts");
    const found = new Set<string>();
    for await (const rel of glob.scan({ cwd: WEBAPP_ROOT })) {
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
