// @spec INDX-010
// @spec INDX-011
//
// Comment style is irrelevant: the literal `@spec` token matches anywhere in
// the line, even inside a string literal. The level token is recorded as
// authored on any file, test or not.

import type { Tag, TagKind, TagLevel } from "@spec-engine/shared";

/** The level capture starts with a letter so stray digits are not picked up,
 *  and allows digits after it so `e2e` is not truncated to `e`. */
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
  // @spec INDX-015
  "_test.go",
  "_test.rs",
  "_spec.lua",
  "_test.lua",
  "/spec/",
]) as readonly string[];

export const LEVELS: ReadonlySet<string> = new Set(["unit", "integration", "e2e"]);

export function isTestFile(fileRel: string): boolean {
  return TEST_MATCH.some((m) => fileRel.includes(m));
}

/**
 * Rows are unsorted: the indexer sorts before insertion to keep the `tags.id`
 * AUTOINCREMENT order stable.
 *
 * @param fileRelToPlatform   Path relative to the platform root, stored
 *                            verbatim into `tags.file`.
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
    const line = lines[i] ?? "";
    // The `g` flag makes lastIndex sticky across exec calls and lines.
    SPEC_TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null = SPEC_TAG_RE.exec(line);
    while (m !== null) {
      const rawLevel = m[2];
      const level: TagLevel =
        rawLevel !== undefined && LEVELS.has(rawLevel) ? (rawLevel as TagLevel) : null;
      hits.push({
        req_id: m[1] ?? "",
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
