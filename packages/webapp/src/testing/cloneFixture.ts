// A copy of `packages/engine/src/testing/cloneFixture.ts`, duplicated rather than
// imported so the engine need not export a cross-package test helper. Tests
// mutate the clone, never `fixtures/platform-fixture/`; callers own cleanup.

import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function cloneFixture(srcDir: string): string {
  const dest = mkdtempSync(join(tmpdir(), "spec-fixture-"));
  cpSync(srcDir, dest, { recursive: true });
  return dest;
}
