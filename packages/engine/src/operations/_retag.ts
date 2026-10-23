import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReqTagRow } from "../resolve/format";
import { DOC_BINDING_RE } from "../scanner/docs";
import { LEVELS, SPEC_TAG_RE } from "../scanner/tags";
import type { FreshTags } from "./_index";
import { toReqTagRows } from "./reads";

const EMPTY_COMMENT_TAIL = /\s*(?:\/\/|#|--|\/\*+\s*\*+\/|<!--\s*-->)\s*$/;
const TRAILING_WORD = /\s+[a-z][a-z0-9]*$/;

/**
 * One line with every `oldId` tag pointed at `newId`, or removed when `newId`
 * is null. Null means the line held nothing but the removed tags and goes.
 * `doc` selects the markdown binding form, the only one a `.md` file indexes.
 */
export function retagLine(
  line: string,
  oldId: string,
  newId: string | null,
  doc: boolean,
): string | null {
  const cr = line.endsWith("\r") ? "\r" : "";
  const body = cr ? line.slice(0, -1) : line;
  const re = doc ? DOC_BINDING_RE : SPEC_TAG_RE;
  if (newId !== null) {
    return body.replace(re, (m, id: string) => (id === oldId ? m.replace(id, newId) : m)) + cr;
  }
  const stripped = body.replace(
    new RegExp(`\\s*(?:${re.source})`, "g"),
    (m, id: string, level: unknown) => {
      if (id !== oldId) return m;
      // The doc form has no level group, so its second argument is the match offset.
      return typeof level === "string" && !LEVELS.has(level)
        ? m.slice(m.search(TRAILING_WORD))
        : "";
    },
  );
  if (stripped === body) return line;
  const rest = stripped.replace(EMPTY_COMMENT_TAIL, "");
  const residue = rest.trim();
  return residue === "" || residue === "*" ? null : rest + cr;
}

/**
 * Rewrite every indexed tag site of `oldId` in place: to `newId`, or removed
 * when `newId` is null. Returns the sites as they stood before the rewrite and
 * reindexes through `freshTags` again so the caller's index sees the result.
 * @spec REQ-065
 * @spec REQ-066
 * @spec REQ-067
 */
export async function applyRetag(
  platformDir: string,
  oldId: string,
  newId: string | null,
  freshTags: FreshTags,
): Promise<ReqTagRow[]> {
  const sites = toReqTagRows(await freshTags(oldId));
  const byFile = new Map<string, { doc: boolean; lines: Set<number> }>();
  for (const site of sites) {
    const entry = byFile.get(site.file) ?? { doc: site.kind === "documents", lines: new Set() };
    entry.lines.add(site.line);
    byFile.set(site.file, entry);
  }
  for (const [file, { doc, lines }] of byFile) {
    const abs = join(platformDir, file);
    const out: string[] = [];
    readFileSync(abs, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const next = lines.has(i + 1) ? retagLine(line, oldId, newId, doc) : line;
        if (next !== null) out.push(next);
      });
    writeFileSync(abs, out.join("\n"));
  }
  if (sites.length > 0) await freshTags(oldId);
  return sites;
}
