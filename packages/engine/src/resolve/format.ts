// packages/engine/src/resolve/format.ts
//
// Pure formatter for `spec resolve <files...>` (RSLV-01 / RSLV-02). Takes
// Requirement[] in (from storage.resolveByFiles() — which runs a DISTINCT
// tags ⨝ requirements join with ORDER BY r.key, r.seq), returns string out.
// No I/O, no Storage, no bun:sqlite. The citty command
// (commands/resolve.ts) prints whatever string renderResolve returns and
// adds a single console.log newline.
//
// RSLV-02: JSON output is byte-stable across consecutive invocations
// against the same DB — `JSON.stringify(sortResolve(rows))` with no
// indentation and no trailing newline. The storage seam already orders
// by (key, seq) ascending; this formatter re-sorts defensively so any
// future seam reorder doesn't silently break the JSON byte-stability
// contract downstream consumers (jq, scripts) rely on.
//
// Em-dash discipline: U+2014 represents "no value / not applicable" for an
// empty TEXT cell. Same constant convention used by map/format.ts,
// propagation/format.ts, and query/format.ts.
//
// TEXT rules: text-mode renders at most 60 characters of `row.text` per
// row; if truncation occurs, append U+2026 (single-character horizontal
// ellipsis). Internal whitespace runs collapse to a single space so the
// table stays single-row-per-requirement. TEXT_MAX = 60 per the plan
// (tighter than query's 80 because the resolve table has fewer columns
// and a Requirement.text body is naturally narrative-paragraph long).
//
// D-08 grep-fence: this file does NOT import bun:sqlite. DB access goes
// exclusively through the Storage interface from @spec-engine/shared.

import type { Requirement } from "@spec-engine/shared";
import type { RenderMode } from "../constants";

// Em-dash literal (U+2014) for empty cells — convention shared with
// map/format.ts, propagation/format.ts, and query/format.ts.
const EMPTY_CELL = "—";
// Horizontal-ellipsis literal (U+2026) appended when TEXT is truncated.
const ELLIPSIS = "…";
// Max TEXT characters before truncation.
const TEXT_MAX = 60;

/**
 * Deterministically sort requirements by `(key, seq)` ascending. Returns a
 * NEW array — never mutates input. Defensive: the storage seam already
 * ORDER BYs the same key, but re-sorting here means JSON byte-stability
 * survives any future SQL reorder.
 */
// @spec RSLV-002
export function sortResolve(rows: Requirement[]): Requirement[] {
  return [...rows].sort((a, b) => (a.key !== b.key ? a.key.localeCompare(b.key) : a.seq - b.seq));
}

/**
 * Render the resolved requirements.
 *
 * mode="json": JSON.stringify(sorted) — no indentation, no trailing newline.
 *   Byte-stable output downstream consumers (jq, scripts) can rely on.
 *
 * mode="text": column-aligned table:
 *     REQ_ID       STATUS      TEXT
 *     BILLING-002  Active      When a customer is charged, the system MUST …
 *     BILLING-009  Active      When a subscription renews, the renewal charge…
 *
 *   TEXT is `row.text.slice(0, 60)` with `"…"` appended if truncation
 *   occurred. Internal whitespace runs collapse to a single space.
 *   Empty TEXT is rendered as the em-dash.
 *
 *   Empty rows → "" (nothing to render).
 */
export function renderResolve(rows: Requirement[], mode: RenderMode): string {
  const sorted = sortResolve(rows);

  if (mode === "json") {
    return JSON.stringify(sorted);
  }

  // Text mode.
  if (sorted.length === 0) return "";

  const header = ["REQ_ID", "STATUS", "TEXT"];
  const lines: string[][] = [header];
  for (const row of sorted) {
    const raw = row.text ?? "";
    const truncated = raw.length > TEXT_MAX ? raw.slice(0, TEXT_MAX) + ELLIPSIS : raw;
    const text = truncated.replace(/\s+/g, " ").trim();
    lines.push([row.id, row.status, text || EMPTY_CELL]);
  }

  // Per-column max width. Em-dash U+2014 and ellipsis U+2026 are single
  // code units in JS strings (BMP), so .length === 1 — same handling as
  // query/format.ts:92.
  const widths = header.map((_, col) => Math.max(...lines.map((row) => row[col]?.length ?? 0)));

  return lines.map((row) => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ")).join("\n");
}

// --- T8: reverse query (`spec resolve --req KEY-NNN`) ----------------------

/** One tag site in `--req` output — a Tag minus the AUTOINCREMENT `id`
 *  (an index implementation detail, not part of the CLI contract). */
export interface ReqTagRow {
  req_id: string;
  repo: string;
  file: string;
  line: number;
  kind: string;
  level: string | null;
}

/** Deterministically sort tag sites by (repo, file, line, req_id) — the
 *  same composite the pipeline sorts tags by before insertion. Returns a
 *  NEW array. Defensive re-sort, same rationale as sortResolve. */
export function sortReqTags(rows: ReqTagRow[]): ReqTagRow[] {
  return [...rows].sort(
    (a, b) =>
      a.repo.localeCompare(b.repo) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.req_id.localeCompare(b.req_id),
  );
}

/**
 * Render the tag sites for one requirement (`--req` mode).
 *
 * mode="json": JSON.stringify(sorted) — no indentation, no trailing
 *   newline (byte-stable, mirrors renderResolve).
 *
 * mode="text": column-aligned table:
 *     REPO   FILE                LINE  KIND        LEVEL
 *     api    api/src/renew.ts    3     implements  —
 *
 *   Empty LEVEL renders as the em-dash. Empty rows → "".
 */
export function renderReqTags(rows: ReqTagRow[], mode: RenderMode): string {
  const sorted = sortReqTags(rows);

  if (mode === "json") {
    return JSON.stringify(sorted);
  }

  if (sorted.length === 0) return "";

  const header = ["REPO", "FILE", "LINE", "KIND", "LEVEL"];
  const lines: string[][] = [header];
  for (const row of sorted) {
    lines.push([row.repo, row.file, String(row.line), row.kind, row.level ?? EMPTY_CELL]);
  }
  const widths = header.map((_, col) => Math.max(...lines.map((l) => (l[col] as string).length)));
  return lines
    .map((l) =>
      l
        .map((cell, col) => cell.padEnd(widths[col] as number))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
