// packages/engine/src/scanner/tags.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INDX-004
//
// PARS-03: `@spec KEY-NNN [level]` tag scanner.
// Analog: src/spec.mjs:115-133 (`isTestFile` + `scanTags`). Port semantics
// verbatim — the legacy regex, TEST_MATCH substring list, and LEVELS set
// already correctly classify the fixture content; the only change is typed
// output rows that match `@spec-engine/shared`'s `Tag` interface.
//
// Source pattern: 02-RESEARCH § Pattern 3 (lines 350-379).
//
// Design notes:
//   1. Comment style is irrelevant — the regex matches the literal `@spec`
//      token anywhere in the line (`// @spec`, `/* @spec`, `# @spec`, even
//      `"@spec ..."` inside a string literal).
//   2. Em-dash, hyphen, JSDoc, plain `//` are all the same to the scanner.
//   3. Kind is path-based: a `@spec` inside `src/renew.ts` is `implements`;
//      the same string inside `test/renew.test.ts` is `verifies`. This
//      mirrors `spec.mjs:115,124`.
//   4. Level is the optional trailing lowercase token, restricted to
//      `unit` / `integration` / `e2e`. Any other token (`huge`, `slow`, etc.)
//      yields `level: null`. The level token is path-independent — a test
//      file may carry an explicit `unit` annotation, and a source file may
//      too (we record the annotation as authored; downstream consumers
//      decide what to do with it).
//   5. `lastIndex = 0` between lines: SPEC_TAG_RE carries the `g` flag, so
//      the matcher state must be reset between input lines or the second
//      line's `exec()` call would resume from wherever the previous line's
//      match left off. Port mirrors `spec.mjs:126` exactly.

import type { Tag, TagKind, TagLevel } from "@spec-engine/shared";

/** The `@spec` tag pattern with optional trailing level token.
 *  Group 1: the requirement id (`BILLING-009`).
 *  Group 2: the optional lowercase level token (validated against LEVELS).
 *
 *  NOTE: the level capture is `[a-z][a-z0-9]*` — must START with a letter
 *  (so stray digits in code don't get picked up), but ALLOWS digits in the
 *  body so the literal `e2e` matches. The legacy `spec.mjs:119` regex used
 *  `[a-z]+` which silently truncated `e2e` to `e` and then failed the
 *  LEVELS check; this is the corresponding bug fix (Rule 1). */
export const SPEC_TAG_RE = /@spec\s+([A-Z][A-Z0-9]*-\d+)(?:\s+([a-z][a-z0-9]*))?/g;

/** Substrings that mark a file path as a test file. Substrings, not
 *  extensions, because `renew.e2e.test.ts` should match on both `.e2e.`
 *  and `.test.`. */
export const TEST_MATCH = Object.freeze([
  ".test.",
  ".spec.",
  "__tests__/",
  "/tests/",
  "/e2e/",
  ".e2e.",
]) as readonly string[];

/** The level tokens we recognize. Anything else → `level: null`. */
export const LEVELS: ReadonlySet<string> = new Set(["unit", "integration", "e2e"]);

/** True if `fileRel` contains any TEST_MATCH substring. */
export function isTestFile(fileRel: string): boolean {
  return TEST_MATCH.some((m) => fileRel.includes(m));
}

/**
 * Scan `text` for `@spec` tags. Returns one row per match.
 *
 * The caller is responsible for any downstream sort (the indexer in
 * plan 02-05 sorts by `(repo, file, line, req_id)` before insertion to
 * keep `tags.id` AUTOINCREMENT order stable — PARS-04).
 *
 * @param repoName            The member repo's logical name (matches
 *                            `repos.name`).
 * @param fileRelToPlatform   Path RELATIVE to platform-fixture root —
 *                            stored verbatim into `tags.file`.
 * @param text                Full text content of the source file.
 */
export function scanTagsInFile(
  repoName: string,
  fileRelToPlatform: string,
  text: string,
): Omit<Tag, "id">[] {
  const kind: TagKind = isTestFile(fileRelToPlatform) ? "verifies" : "implements";
  const hits: Omit<Tag, "id">[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    // Reset the regex matcher state between lines (the `g` flag makes
    // SPEC_TAG_RE.lastIndex sticky across exec calls).
    SPEC_TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null = SPEC_TAG_RE.exec(line);
    while (m !== null) {
      const rawLevel = m[2];
      const level: TagLevel =
        rawLevel !== undefined && LEVELS.has(rawLevel) ? (rawLevel as TagLevel) : null;
      hits.push({
        req_id: m[1] as string,
        repo: repoName,
        file: fileRelToPlatform,
        line: i + 1,
        kind,
        level,
      });
      m = SPEC_TAG_RE.exec(line);
    }
  }
  return hits;
}
