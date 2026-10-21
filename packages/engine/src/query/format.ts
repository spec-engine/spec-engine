import type { FtsHit } from "@spec-engine/shared";
import type { RenderMode } from "../constants";

const EMPTY_CELL = "—";
const ELLIPSIS = "…";
const EXCERPT_MAX = 80;

/**
 * bm25 scores are negative and smaller is better, so ascending is best first.
 * The storage seam already orders by rank; re-sorting here keeps JSON
 * byte-stable if that SQL ever changes.
 */
export function sortHits(hits: FtsHit[]): FtsHit[] {
  return [...hits].sort((a, b) => a.rank - b.rank);
}

function excerptOf(raw: string): string {
  const truncated = raw.length > EXCERPT_MAX ? raw.slice(0, EXCERPT_MAX) + ELLIPSIS : raw;
  return truncated.replace(/\s+/g, " ").trim() || EMPTY_CELL;
}

/** Width is `.length`: the em-dash and ellipsis are single BMP code units. */
function renderTable(header: string[], rows: string[][]): string {
  const lines = [header, ...rows];
  const widths = header.map((_, col) => Math.max(...lines.map((row) => row[col]?.length ?? 0)));
  return lines.map((row) => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ")).join("\n");
}

export function renderQuery(hits: FtsHit[], mode: RenderMode): string {
  const sorted = sortHits(hits);

  if (mode === "json") {
    return JSON.stringify(sorted);
  }

  if (sorted.length === 0) return "";

  // @spec QURY-008
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
