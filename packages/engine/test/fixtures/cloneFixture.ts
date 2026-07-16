// packages/engine/test/fixtures/cloneFixture.ts
//
// Test helper for Phase 3 plan 03-05.
//
// Tests that mutate fixture content (e.g., the inverted self-test in
// `check-ci.test.ts`, which strips the planted BILLING-999 spec-tag line
// to prove the inverted CI assertion is honest) MUST clone the canonical
// fixture first so `fixtures/platform-fixture/` is never modified by a
// test run. The canonical fixture is the source of truth for CHCK-04 —
// touching it in-place would silently corrupt every later test invocation.
//
// API is intentionally sync (no Promise) — test setup tends to be linear,
// and the recursive copy is small enough that the blocking call is fine.
//
// Callers own cleanup via `rmSync(tmpDir, { recursive: true, force: true })`
// in `afterEach` — the helper does NOT register any finalizer of its own.

import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Recursively copy `srcDir` into a fresh tmpdir under
 * `os.tmpdir()/spec-fixture-XXXX` and return the absolute tmp path.
 *
 * Used by tests that need a mutable working copy of a fixture tree —
 * principally the inverted self-test in `check-ci.test.ts` and the
 * cold-rebuild proof in `check-ci-cold-rebuild.test.ts`.
 */
export function cloneFixture(srcDir: string): string {
  const dest = mkdtempSync(join(tmpdir(), "spec-fixture-"));
  cpSync(srcDir, dest, { recursive: true });
  return dest;
}

/**
 * Compose an `@spec` tag comment line at runtime (Phase 21-03, T-21-09).
 *
 * Fixture content written into a tmp member repo must carry a literal
 * `@spec <ID>` tag so the indexer's coverage lands. But if that adjacency
 * appears in this repo's OWN scanned test SOURCE, the self-scan reads it as a
 * repo self-member tag and it dangles (BILLING is a fixture id, never a repo
 * spec — and must never become one). Composing the token here keeps the
 * WRITTEN bytes byte-identical to the old inline literal while the test SOURCE
 * never contains the tag-keyword/id adjacency that SPEC_TAG_RE matches.
 *
 * `specTag("BILLING-009")` returns exactly the string `// ` + tag-keyword +
 * ` BILLING-009`, so composing it with `\nexport const ...` emits the same
 * bytes as the previous inline string literal.
 */
export const specTag = (id: string): string => `// @spec ${id}`;
