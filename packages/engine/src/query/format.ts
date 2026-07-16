// packages/engine/src/query/format.ts
//
// Pure formatter for `spec query <text>` (QURY-01 / QURY-02). Takes
// FtsHit[] in (from storage.searchFts() — which runs FTS_SEARCH_SQL with
// porter-stemmed bm25 ranking + Superseded filter), returns string out.
// No I/O, no Storage, no bun:sqlite. The citty command (commands/query.ts)
// prints whatever string renderQuery returns and adds a single console.log
// newline.
//
// QURY-02: the headline value moment is "renewal charge" → BILLING-009. The
// storage seam already orders by rank ASC (bm25 returns a negative score; a
// smaller — more negative — value means a better match per SQLite's bm25
// convention). This formatter re-sorts defensively so any future seam
// reorder doesn't silently break JSON byte-stability.
//
// Em-dash discipline: U+2014 represents "no value / not applicable" for an
// empty excerpt cell. Same constant convention used by map/format.ts and
// propagation/format.ts.
//
// Excerpt rules: text-mode renders at most 80 visual columns of `hit.text`
// per row; if truncation occurs, append U+2026 (single-character horizontal
// ellipsis). Internal whitespace runs collapse to a single space so the
// table stays single-row-per-hit. EXCERPT_MAX = 80 per 04-RESEARCH § CLI
// Surface — pragmatic terminal width budget for a 4-column table.
//
// D-08 grep-fence: this file does NOT import bun:sqlite. DB access goes
// exclusively through the Storage interface from @spec-engine/shared.

import type { FtsHit } from "@spec-engine/shared";
import type { RenderMode } from "../constants";

// Em-dash literal (U+2014) for empty cells — convention shared with
// map/format.ts and propagation/format.ts.
const EMPTY_CELL = "—";
// Horizontal-ellipsis literal (U+2026) appended when an excerpt is truncated.
const ELLIPSIS = "…";
// Max excerpt characters before truncation (per 04-RESEARCH § CLI Surface).
const EXCERPT_MAX = 80;

/**
 * Deterministically sort FTS hits by `rank` ascending. Returns a NEW array
 * — never mutates input. Defensive: the storage seam already ORDER BYs the
 * same key, but re-sorting here means JSON byte-stability survives any
 * future SQL reorder.
 */
export function sortHits(hits: FtsHit[]): FtsHit[] {
  return [...hits].sort((a, b) => a.rank - b.rank);
}

/** Collapse a raw definition/text field to a single-line excerpt: truncate at
 *  EXCERPT_MAX (appending the ellipsis), collapse internal whitespace runs,
 *  and fall back to the em-dash when empty. Shared by both the Requirements
 *  and Terms tables so the excerpt discipline is identical. */
function excerptOf(raw: string): string {
  const truncated = raw.length > EXCERPT_MAX ? raw.slice(0, EXCERPT_MAX) + ELLIPSIS : raw;
  return truncated.replace(/\s+/g, " ").trim() || EMPTY_CELL;
}

/** Render a `header + rows` matrix as a padded, two-space-gutter table. Em-dash
 *  U+2014 and ellipsis U+2026 are single BMP code units (`.length === 1`) —
 *  same width handling as map/format.ts and propagation/format.ts. */
function renderTable(header: string[], rows: string[][]): string {
  const lines = [header, ...rows];
  const widths = header.map((_, col) => Math.max(...lines.map((row) => row[col]?.length ?? 0)));
  return lines.map((row) => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ")).join("\n");
}

/**
 * Render the FTS hits.
 *
 * mode="json": JSON.stringify(sorted) — no indentation, no trailing newline.
 *   Byte-stable output downstream consumers (jq, scripts) can rely on. Each
 *   hit now carries the `key` discriminator (TERM-07); the sort key is
 *   unchanged (rank ASC), so the serialization stays deterministic.
 *
 * mode="text": TERM-07 splits the hits into two column-aligned groups so a
 *   glossary definition surfaces BESIDE requirement hits. Requirements first,
 *   then Terms; a group is omitted entirely when it has no hits.
 *
 *     Requirements
 *     REQ_ID       RANK     SOURCE                          EXCERPT
 *     BILLING-009  -1.234   spec-engine/BILLING/SPEC.json:42 When a subscription renews, …
 *
 *     Terms
 *     TERM      DEFINITION
 *     TERM-016  the disposable `.spec-engine/index.sqlite` built from …
 *
 *   EXCERPT / DEFINITION is `hit.text.slice(0, 80)` with `"…"` appended if
 *   truncation occurred; internal whitespace runs collapse to a single space;
 *   an empty cell renders as the em-dash.
 *
 *   Empty hits → "" (nothing to render).
 */
export function renderQuery(hits: FtsHit[], mode: RenderMode): string {
  const sorted = sortHits(hits);

  if (mode === "json") {
    return JSON.stringify(sorted);
  }

  // Text mode.
  if (sorted.length === 0) return "";

  // TERM-07: partition on the FtsHit key discriminator — terms are rows in the
  // reserved TERM domain that ride the same FTS index. Both filters preserve
  // the rank-ascending order of `sorted`.
  // @spec QURY-003
  const termHits = sorted.filter((hit) => hit.key === "TERM");
  const reqHits = sorted.filter((hit) => hit.key !== "TERM");

  const sections: string[] = [];

  if (reqHits.length > 0) {
    const rows = reqHits.map((hit) => [
      hit.req_id,
      hit.rank.toFixed(3),
      `${hit.source_file}:${hit.line}`,
      excerptOf(hit.text ?? ""),
    ]);
    sections.push(`Requirements\n${renderTable(["REQ_ID", "RANK", "SOURCE", "EXCERPT"], rows)}`);
  }

  if (termHits.length > 0) {
    const rows = termHits.map((hit) => [hit.req_id, excerptOf(hit.text ?? "")]);
    sections.push(`Terms\n${renderTable(["TERM", "DEFINITION"], rows)}`);
  }

  return sections.join("\n\n");
}
