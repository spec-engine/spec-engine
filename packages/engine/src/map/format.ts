// packages/engine/src/map/format.ts
//
// Pure formatter for the cross-repo coverage matrix (MAP-01 / MAP-02).
// Takes CoverageRow[] in (from storage.coverageMatrix() — which reads the
// `coverage` SQL VIEW), returns string out. No I/O, no Storage, no
// bun:sqlite. The citty command (commands/map.ts) prints whatever string
// renderMatrix returns and adds a single console.log newline.
//
// MAP-01: render directly from the `coverage` VIEW (Invariant #3 — never
// materialized).
// MAP-02: deterministic sort by (domain_key ASC, req_seq ASC, repo ASC)
// so JSON-mode output is byte-stable across consecutive invocations and
// snapshot-testable.
//
// Sort key rationale:
//   - domain_key alphabetic: AUTH before BILLING.
//   - req_seq numeric (parseInt on the suffix after "-"): BILLING-009 must
//     come before BILLING-010 — lexicographic compare would put 010 first.
//   - repo alphabetic: 'admin' < 'api' < 'mobile' (column-stable order).
//
// D-08 grep-fence: this file does not import bun:sqlite.
// Pattern source: 03-RESEARCH.md § `spec map` Rendering.

import type { CoverageRow } from "@spec-engine/shared";
import type { RenderMode } from "../constants";

// Em-dash literal (U+2014) for empty cells. Keep in sync with the wider
// project's em-dash discipline — PROJECT.md uses em-dash for "not
// applicable / no coverage" throughout, including the SPEC.md Lives in
// section.
const EMPTY_CELL = "—";

/**
 * Parse the numeric sequence suffix from a requirement id like "BILLING-009"
 * → 9. Falls back to 0 if the id doesn't carry a parseable suffix (defensive
 * — coverageMatrix should never emit such a row, but we don't want a
 * NaN-driven undefined sort).
 */
function reqSeq(reqId: string): number {
  const parts = reqId.split("-");
  if (parts.length < 2) return 0;
  const n = Number.parseInt(parts[1] ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Deterministically sort coverage rows by (domain_key ASC, req_seq ASC,
 * repo ASC). Returns a NEW array — never mutates input. MAP-02: this sort
 * is what makes the JSON projection byte-stable across runs.
 */
export function sortMatrix(rows: CoverageRow[]): CoverageRow[] {
  return [...rows].sort((a, b) => {
    const domainCmp = a.domain_key.localeCompare(b.domain_key);
    if (domainCmp !== 0) return domainCmp;
    const seqCmp = reqSeq(a.req_id) - reqSeq(b.req_id);
    if (seqCmp !== 0) return seqCmp;
    return a.repo.localeCompare(b.repo);
  });
}

/**
 * Status cell label for a single (req, repo) coverage row. Four branches:
 *   - implemented && verified → "src+test"
 *   - implemented only       → "src"
 *   - verified only          → "test"
 *   - neither                → "—" (em-dash U+2014)
 */
export function cellStatus(row: CoverageRow): "src+test" | "src" | "test" | "—" {
  if (row.implemented === 1 && row.verified === 1) return "src+test";
  if (row.implemented === 1) return "src";
  if (row.verified === 1) return "test";
  return EMPTY_CELL;
}

/**
 * Render the coverage matrix. Always sorts first via sortMatrix.
 *
 * mode="json": JSON.stringify(sorted) — no indentation, no trailing newline.
 *   Matches 03-03 formatter style and gives byte-stable output for MAP-02.
 *
 * mode="text": column-per-repo table:
 *     DOMAIN  REQUIREMENT  STATUS      api      mobile   admin
 *     AUTH    AUTH-001     Active      src+test —        —
 *     ...
 *   Repos are derived from rows (unique, alphabetic). Cell value is
 *   cellStatus(row) for each (req, repo) pair. Column widths are computed
 *   from max content width per column.
 *
 *   Empty input → "" (no rows means no repos to discover → no columns).
 */
export function renderMatrix(rows: CoverageRow[], mode: RenderMode): string {
  const sorted = sortMatrix(rows);

  if (mode === "json") {
    return JSON.stringify(sorted);
  }

  // Text mode.
  if (sorted.length === 0) return "";

  // Distinct repos, alphabetic — one column per repo.
  const repos = Array.from(new Set(sorted.map((r) => r.repo))).sort((a, b) => a.localeCompare(b));

  // Group sorted rows by req_id. Since sortMatrix already sorts by
  // (domain, seq, repo), the iteration order over a Map populated in that
  // order is the row order we want.
  const byReq = new Map<
    string,
    { domain_key: string; req_id: string; req_status: string; cells: Map<string, string> }
  >();
  for (const row of sorted) {
    let entry = byReq.get(row.req_id);
    if (!entry) {
      entry = {
        domain_key: row.domain_key,
        req_id: row.req_id,
        req_status: row.req_status,
        cells: new Map(),
      };
      byReq.set(row.req_id, entry);
    }
    entry.cells.set(row.repo, cellStatus(row));
  }

  // Build rows as string arrays so we can compute per-column max width.
  const header = ["DOMAIN", "REQUIREMENT", "STATUS", ...repos];
  const lines: string[][] = [header];
  for (const entry of byReq.values()) {
    const cells = repos.map((r) => entry.cells.get(r) ?? EMPTY_CELL);
    lines.push([entry.domain_key, entry.req_id, entry.req_status, ...cells]);
  }

  // Compute max width per column. Use [...str].length so a single em-dash
  // (which is 3 bytes UTF-8 but 1 visual column) doesn't over-pad. For the
  // PoC, JS string .length is "code units"; em-dash is a single code unit
  // (U+2014, BMP), so .length === 1 works correctly here.
  const widths = header.map((_, col) => Math.max(...lines.map((row) => row[col]?.length ?? 0)));

  // Render: each cell padEnd to its column width, joined by two spaces.
  return lines.map((row) => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ")).join("\n");
}
