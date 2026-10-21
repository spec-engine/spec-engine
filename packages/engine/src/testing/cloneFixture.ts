// A test that mutates fixture content must clone it first: editing
// `fixtures/platform-fixture/` in place would silently corrupt every later
// test run. Callers own cleanup; the helper registers no finalizer.

import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function cloneFixture(srcDir: string): string {
  const dest = mkdtempSync(join(tmpdir(), "spec-fixture-"));
  cpSync(srcDir, dest, { recursive: true });
  return dest;
}

/**
 * Fixture content written into a tmp member repo must carry a literal tag, but
 * the same adjacency in this repo's own test source would be self-scanned as a
 * dangling tag (BILLING is a fixture domain, never a repo spec). Composing the
 * token at runtime keeps the tag-keyword/id adjacency out of the source.
 */
export const specTag = (id: string): string => `// @spec ${id}`;
