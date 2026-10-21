// The scanner matches the tag pattern anywhere in a line, string literals
// included, so a literal tag in a test would index as a dangling tag of this
// repo. Composing the line from SPEC_TOKEN keeps the runtime bytes identical
// while the source line stays unmatchable.

/** The literal tag token, isolated so `${SPEC_TOKEN} <ID>` in a template
 *  literal never forms a scannable source line. */
export const SPEC_TOKEN = "@spec";

/** A full tag line: `// @spec <id>` (+ optional level), newline-terminated. */
export function specTag(id: string, level?: string): string {
  return `// ${SPEC_TOKEN} ${id}${level ? ` ${level}` : ""}\n`;
}
