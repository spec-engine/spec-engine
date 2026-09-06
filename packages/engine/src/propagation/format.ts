// packages/engine/src/propagation/format.ts
//
// Pure formatter for `spec propagation <KEY-NNN>`: PropagationRow[] in, string
// out, in the order the rows arrive. The drift overlay and the row order are
// storage's; this file recomputes neither.

import type { PropagationRow } from "@spec-engine/shared";
import type { RenderMode } from "../constants";

/** U+2014 for an empty cell, the same constant map/format.ts uses. */
const EMPTY_CELL = "—";

/**
 * Render the propagation rows in the given order.
 *
 * mode="json": JSON.stringify(rows), no indentation, no trailing newline.
 *
 * mode="text": a column-aligned table:
 *     REPO    STATE                VIA          DRIFT?
 *     api     MIGRATED_VERIFIED    —            no
 *     mobile  ON_PREDECESSOR       BILLING-001  yes
 *
 *   VIA is the em dash when via_req_id is null. Empty input renders "".
 */
export function renderPropagation(rows: readonly PropagationRow[], mode: RenderMode): string {
  if (mode === "json") {
    return JSON.stringify(rows);
  }
  if (rows.length === 0) return "";
  const header = ["REPO", "STATE", "VIA", "DRIFT?"];
  const lines: string[][] = [header];
  for (const row of rows) {
    lines.push([row.repo, row.state, row.via_req_id ?? EMPTY_CELL, row.drifted ? "yes" : "no"]);
  }
  const widths = header.map((_, col) => Math.max(...lines.map((row) => row[col]?.length ?? 0)));
  return lines.map((row) => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ")).join("\n");
}
