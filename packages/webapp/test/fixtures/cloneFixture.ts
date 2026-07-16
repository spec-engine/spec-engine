// packages/webapp/test/fixtures/cloneFixture.ts
//
// Mirrors `packages/engine/test/fixtures/cloneFixture.ts`. Test-only helper
// — copies the canonical platform-fixture into a fresh tmpdir so each test
// run owns a mutable copy and never modifies `fixtures/platform-fixture/`
// in place (WR-06). Callers own cleanup via `rmSync` in `afterAll`.
//
// Why duplicated rather than imported from engine: this file is `test/`
// only and the engine's helper imports `node:fs` directly. Both webapp
// and engine test trees need the same shape; duplicating ~10 lines is
// cleaner than adding a cross-package test helper export.

import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Recursively copy `srcDir` into a fresh tmpdir and return the absolute
 *  tmp path. The caller is responsible for cleanup. */
export function cloneFixture(srcDir: string): string {
  const dest = mkdtempSync(join(tmpdir(), "spec-fixture-"));
  cpSync(srcDir, dest, { recursive: true });
  return dest;
}
