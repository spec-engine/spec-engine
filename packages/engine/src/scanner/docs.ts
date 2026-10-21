// Markdown is not code, so the code scanner's "match `@spec` anywhere on the
// line" rule would be a footgun: READMEs show `// @spec KEY-NNN` examples in
// prose and fenced blocks, and none of those may mint a tag. Only the explicit
// HTML-comment form binds:
//
//   Guides render at build time. <!-- @spec KEY-NNN -->
//
// The KEY-NNN placeholder is deliberate: the code scanner matches
// `@spec <real-id>` anywhere in a .ts line, so a real id here would index as a
// dangling tag.
//
// Line-based: fenced code blocks are not parsed out, so a fenced example of
// the HTML-comment form would bind. Accepted; the realistic fenced example is
// the code-comment form, which never matches.

import type { Tag } from "@spec-engine/shared";

/** The one and only doc-binding form: an HTML comment wrapping `@spec` and
 *  a requirement id. Whitespace is flexible; the id grammar matches
 *  SPEC_TAG_RE's (`[A-Z][A-Z0-9]*-\d+`). No level token — docs don't
 *  verify at a level. */
export const DOC_BINDING_RE = /<!--\s*@spec\s+([A-Z][A-Z0-9]*-\d+)\s*-->/g;

/** Requirement-id-shaped token, for mention detection. Same id grammar as
 *  the binding form; the pipeline (not this scanner) decides whether a
 *  candidate is a KNOWN requirement. */
export const REQ_ID_MENTION_RE = /\b[A-Z][A-Z0-9]*-\d+\b/g;

/** An unbound requirement-id-shaped token found in a doc line. Routed to
 *  doctor.md triage once the pipeline confirms the id is a known
 *  requirement. */
export interface DocMention {
  req_id: string;
  repo: string;
  file: string;
  line: number;
  /** The trimmed source line, for human triage context. */
  text: string;
}

/**
 * @param fileRelToPlatform  Path relative to the platform root, stored verbatim
 *                           into `tags.file`.
 */
export function scanDocFile(
  repoName: string,
  fileRelToPlatform: string,
  text: string,
): { tags: Omit<Tag, "id">[]; mentions: DocMention[] } {
  const tags: Omit<Tag, "id">[] = [];
  const mentions: DocMention[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Bindings first — they double as the per-line "already bound" set.
    const boundIds = new Set<string>();
    DOC_BINDING_RE.lastIndex = 0;
    let b: RegExpExecArray | null = DOC_BINDING_RE.exec(line);
    while (b !== null) {
      const id = b[1] ?? "";
      boundIds.add(id);
      tags.push({
        req_id: id,
        repo: repoName,
        file: fileRelToPlatform,
        line: i + 1,
        kind: "documents",
        level: null,
      });
      b = DOC_BINDING_RE.exec(line);
    }

    // Mention candidates: id-shaped tokens not bound on this line. Dedupe
    // per (line, id) so "DOCS-003 ... DOCS-003" yields one triage row.
    const seen = new Set<string>();
    REQ_ID_MENTION_RE.lastIndex = 0;
    let m: RegExpExecArray | null = REQ_ID_MENTION_RE.exec(line);
    while (m !== null) {
      const id = m[0];
      if (!boundIds.has(id) && !seen.has(id)) {
        seen.add(id);
        mentions.push({
          req_id: id,
          repo: repoName,
          file: fileRelToPlatform,
          line: i + 1,
          text: line.trim(),
        });
      }
      m = REQ_ID_MENTION_RE.exec(line);
    }
  }
  return { tags, mentions };
}
