import type { CoverageRow } from "@spec-engine/shared";
import type { RenderMode } from "../constants";

const EMPTY_CELL = "—";

/** 0 for an unparseable suffix, so a NaN can never make the sort undefined. */
function reqSeq(reqId: string): number {
  const parts = reqId.split("-");
  if (parts.length < 2) return 0;
  const n = Number.parseInt(parts[1] ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/** The seq compares numerically, so an id past 999 still sorts after 999. */
export function sortMatrix(rows: CoverageRow[]): CoverageRow[] {
  return [...rows].sort((a, b) => {
    const domainCmp = a.domain_key.localeCompare(b.domain_key);
    if (domainCmp !== 0) return domainCmp;
    const seqCmp = reqSeq(a.req_id) - reqSeq(b.req_id);
    if (seqCmp !== 0) return seqCmp;
    return a.repo.localeCompare(b.repo);
  });
}

export function cellStatus(row: CoverageRow): "src+test" | "src" | "test" | "—" {
  if (row.implemented === 1 && row.verified === 1) return "src+test";
  if (row.implemented === 1) return "src";
  if (row.verified === 1) return "test";
  return EMPTY_CELL;
}

/** Empty input renders "": with no rows there are no repo columns to discover. */
export function renderMatrix(rows: CoverageRow[], mode: RenderMode): string {
  const sorted = sortMatrix(rows);

  if (mode === "json") {
    return JSON.stringify(sorted);
  }

  if (sorted.length === 0) return "";

  const repos = Array.from(new Set(sorted.map((r) => r.repo))).sort((a, b) => a.localeCompare(b));

  // Map insertion order over the sorted rows is the output row order.
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

  const header = ["DOMAIN", "REQUIREMENT", "STATUS", ...repos];
  const lines: string[][] = [header];
  for (const entry of byReq.values()) {
    const cells = repos.map((r) => entry.cells.get(r) ?? EMPTY_CELL);
    lines.push([entry.domain_key, entry.req_id, entry.req_status, ...cells]);
  }

  // .length counts UTF-16 code units; the em-dash is one (BMP), so it pads as
  // one column. An astral character in a cell would over-pad.
  const widths = header.map((_, col) => Math.max(...lines.map((row) => row[col]?.length ?? 0)));

  return lines.map((row) => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ")).join("\n");
}
