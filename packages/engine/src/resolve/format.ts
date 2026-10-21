import type { Requirement } from "@spec-engine/shared";
import type { RenderMode } from "../constants";

// The empty-cell em-dash is shared with map/, propagation/, and query/format.ts.
const EMPTY_CELL = "—";
const ELLIPSIS = "…";
// Tighter than query's 80: a Requirement.text body runs paragraph-long.
const TEXT_MAX = 60;

/**
 * The storage seam already orders by the same key; re-sorting here keeps JSON
 * byte-stability through any future SQL reorder.
 */
// @spec RSLV-004
export function sortResolve(rows: Requirement[]): Requirement[] {
  return [...rows].sort((a, b) => (a.key !== b.key ? a.key.localeCompare(b.key) : a.seq - b.seq));
}

export function renderResolve(rows: Requirement[], mode: RenderMode): string {
  const sorted = sortResolve(rows);

  if (mode === "json") {
    return JSON.stringify(sorted);
  }

  if (sorted.length === 0) return "";

  const header = ["REQ_ID", "STATUS", "TEXT"];
  const lines: string[][] = [header];
  for (const row of sorted) {
    const raw = row.text ?? "";
    const truncated = raw.length > TEXT_MAX ? raw.slice(0, TEXT_MAX) + ELLIPSIS : raw;
    const text = truncated.replace(/\s+/g, " ").trim();
    lines.push([row.id, row.status, text || EMPTY_CELL]);
  }

  // The em-dash and ellipsis are single BMP code units, so .length counts them as 1.
  const widths = header.map((_, col) => Math.max(...lines.map((row) => row[col]?.length ?? 0)));

  return lines.map((row) => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ")).join("\n");
}

/** A Tag minus the AUTOINCREMENT `id`, an index detail outside the CLI contract. */
export interface ReqTagRow {
  req_id: string;
  repo: string;
  file: string;
  line: number;
  kind: string;
  level: string | null;
}

/** The same composite the pipeline sorts tags by before insertion. */
export function sortReqTags(rows: ReqTagRow[]): ReqTagRow[] {
  return [...rows].sort(
    (a, b) =>
      a.repo.localeCompare(b.repo) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.req_id.localeCompare(b.req_id),
  );
}

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
  const widths = header.map((_, col) => Math.max(...lines.map((l) => (l[col] ?? "").length)));
  return lines
    .map((l) =>
      l
        .map((cell, col) => cell.padEnd(widths[col] as number))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
