// packages/engine/src/records/format.ts
//
// Pure formatter for `spec get` and `spec list`. Rows arrive in the index's
// (key, seq) order and are rendered as given; JSON mode is the rows verbatim.

import type { Requirement } from "@spec-engine/shared";
import type { RenderMode } from "../constants";

const HEADER = ["ID", "STATUS", "KEY", "SEQ", "CHANGED_AT", "TEXT"];

/**
 * mode="json": `JSON.stringify(rows)`, no indentation, no trailing newline.
 * mode="text": a column-aligned table with one row per requirement; the
 *   statement is the last column so it never pushes the fixed columns around.
 *   Empty input renders "".
 */
export function renderRecords(rows: readonly Requirement[], mode: RenderMode): string {
  if (mode === "json") return JSON.stringify(rows);
  if (rows.length === 0) return "";
  const lines: string[][] = [HEADER];
  for (const r of rows) {
    lines.push([r.id, r.status, r.key, String(r.seq), String(r.changed_at_version), r.text]);
  }
  const fixed = HEADER.length - 1;
  const widths = HEADER.slice(0, fixed).map((_, col) =>
    Math.max(...lines.map((row) => row[col]?.length ?? 0)),
  );
  return lines
    .map((row) =>
      row
        .map((cell, i) => (i < fixed ? cell.padEnd(widths[i] ?? 0) : cell))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
