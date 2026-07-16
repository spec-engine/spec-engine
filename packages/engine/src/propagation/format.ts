// packages/engine/src/propagation/format.ts
//
// Pure formatter for the `spec propagation <KEY-NNN>` command (PROP-01 /
// PROP-03). Takes PropagationRow[] in (from storage.propagationFor() — which
// runs PROP_REPO_STATES_SQL and overlays the drift set from listDriftRows()),
// returns string out. No I/O, no Storage, no bun:sqlite. The citty command
// (commands/propagation.ts) prints whatever string renderPropagation returns
// and adds a single console.log newline.
//
// PROP-01: the drift overlay is consumed via storage.propagationFor() — this
// formatter never redefines or recomputes the drift predicate.
// PROP-03: column STATE renders the five PropagationState literal values
// verbatim (MIGRATED_VERIFIED, MIGRATED_UNVERIFIED, ON_PREDECESSOR,
// ON_OTHER_DOMAIN_REQ, NO_DOMAIN_REFERENCE) — see PropagationState in
// @spec-engine/shared for the canonical set.
//
// Em-dash discipline: U+2014 represents "no value / not applicable" for the
// VIA column when via_req_id is null (states MIGRATED_VERIFIED,
// MIGRATED_UNVERIFIED, NO_DOMAIN_REFERENCE). Same constant used by
// map/format.ts.
//
// D-08 grep-fence: this file does NOT import bun:sqlite. DB access goes
// exclusively through the Storage interface from @spec-engine/shared.

import type { PropagationRow } from "@spec-engine/shared";
import type { RenderMode } from "../constants";

// Em-dash literal (U+2014) for empty cells. Kept in sync with map/format.ts's
// EMPTY_CELL constant — project-wide convention for "no value to render".
const EMPTY_CELL = "—";

/**
 * Deterministically sort propagation rows by repo ASC. Returns a NEW array —
 * never mutates input. Mirrors sortMatrix from map/format.ts so JSON-mode
 * output is byte-stable across consecutive invocations (snapshot-testable).
 */
export function sortPropagation(rows: PropagationRow[]): PropagationRow[] {
  return [...rows].sort((a, b) => a.repo.localeCompare(b.repo));
}

/**
 * Render the propagation rows.
 *
 * mode="json": JSON.stringify(sorted) — no indentation, no trailing newline.
 *   Byte-stable output for snapshot-locking the JSON contract.
 *
 * mode="text": column-aligned table:
 *     REPO    STATE                VIA          DRIFT?
 *     admin   ON_OTHER_DOMAIN_REQ  BILLING-007  no
 *     api     MIGRATED_VERIFIED    —            no
 *     mobile  ON_PREDECESSOR       BILLING-001  yes
 *
 *   VIA cell is the em-dash (U+2014) when row.via_req_id is null.
 *   DRIFT? cell is "yes" when row.drifted is true, "no" otherwise.
 *
 *   Empty input → "" (no rows means nothing to render).
 */
export function renderPropagation(rows: PropagationRow[], mode: RenderMode): string {
  const sorted = sortPropagation(rows);

  if (mode === "json") {
    return JSON.stringify(sorted);
  }

  // Text mode.
  if (sorted.length === 0) return "";

  const header = ["REPO", "STATE", "VIA", "DRIFT?"];
  const lines: string[][] = [header];
  for (const row of sorted) {
    lines.push([row.repo, row.state, row.via_req_id ?? EMPTY_CELL, row.drifted ? "yes" : "no"]);
  }

  // Per-column max width. Em-dash U+2014 is a single code unit in JS strings
  // (BMP), so .length === 1 — same handling as map/format.ts:138.
  const widths = header.map((_, col) => Math.max(...lines.map((row) => row[col]?.length ?? 0)));

  return lines.map((row) => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ")).join("\n");
}
