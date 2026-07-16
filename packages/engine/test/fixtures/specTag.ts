// packages/engine/test/fixtures/specTag.ts
//
// DOGFOOD helper: build `// @spec <ID> [level]` tag lines at RUNTIME so the
// literal token+id pair never appears in test source. spec-check self-consumes
// this repo (root spec-engine/ + @spec tags in packages/), and the scanner
// deliberately matches the tag pattern anywhere in a line — including inside
// string literals (scanner/tags.ts design note 1). A literal "// @spec
// TEST-001" in a test file would therefore index as a real (dangling) tag
// of THIS repo. Composing the string from SPEC_TOKEN keeps the runtime
// bytes identical while making the source line unmatchable.
//
// This file lives under test/fixtures/ — an IGNORE_SUBSTR subtree — so it
// is doubly invisible to the self-scan.

/** The literal tag token, isolated so `${SPEC_TOKEN} <ID>` in a template
 *  literal never forms a scannable source line. */
export const SPEC_TOKEN = "@spec";

/** A full tag line: `// @spec <id>` (+ optional level), newline-terminated. */
export function specTag(id: string, level?: string): string {
  return `// ${SPEC_TOKEN} ${id}${level ? ` ${level}` : ""}\n`;
}
