// packages/engine/src/scanner/docs.ts
//
// RED-15: documentation-binding scanner for member `.md` files.
//
// Markdown is NOT code, so the code scanner's "match `@spec` anywhere on
// the line" rule (scanner/tags.ts Design note 1) would be a footgun here:
// READMEs and guides legitimately SHOW `// @spec KEY-NNN` examples in
// prose and fenced code blocks (this repo's own README does), and none of
// those may mint a tag. Only the explicit HTML-comment form binds:
//
//   Guides render at build time. <!-- @spec KEY-NNN -->
//
// (Generic KEY-NNN placeholder here on purpose: this repo self-consumes,
// and the CODE scanner matches `@spec <real-id>` anywhere in a .ts line —
// a realistic example id in this comment would index as a dangling tag.)
//
// Bindings index as kind `documents` (level is always null — levels are a
// test-tag concept). Everything else requirement-id-shaped on a line
// WITHOUT a binding for that same id is returned as a MENTION candidate;
// the pipeline filters candidates against the known-requirement set (so
// issue-tracker refs like JIRA-123 never surface) and routes the
// survivors into doctor.md for human triage.
//
// Line-based like scanTagsInFile: fenced code blocks are NOT parsed out.
// A fenced example containing the literal HTML-comment binding form would
// bind — accepted PoC limitation, documented here; the realistic fenced
// example is the code-comment form, which never matches.

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
 * Scan one markdown file for explicit doc bindings and mention candidates.
 *
 * Per line: every `<!-- @spec ID -->` becomes a `documents`-kind tag; every
 * other id-shaped token on the line that is NOT bound on that same line
 * becomes a mention candidate. A line binding DOCS-003 while mentioning
 * DOCS-002 in prose therefore yields one tag (DOCS-003) and one candidate
 * (DOCS-002).
 *
 * @param repoName           The member repo's logical name (matches `repos.name`).
 * @param fileRelToPlatform  Path RELATIVE to the platform root — stored verbatim
 *                           into `tags.file` (same invariant as scanTagsInFile).
 * @param text               Full text content of the markdown file.
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
    const line = lines[i] as string;

    // Bindings first — they double as the per-line "already bound" set.
    const boundIds = new Set<string>();
    DOC_BINDING_RE.lastIndex = 0;
    let b: RegExpExecArray | null = DOC_BINDING_RE.exec(line);
    while (b !== null) {
      const id = b[1] as string;
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
