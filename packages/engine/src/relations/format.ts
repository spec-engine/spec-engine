// The CLI and `/api/relations?format=mermaid` both render through this file,
// so the two surfaces cannot drift; the webapp reads the mermaid text through
// the API because its import fence forbids importing the engine.
//
// `graph LR`, not `erDiagram`: requirements relate associatively and ER
// cardinality means nothing here. A Relates to a missing id still renders as
// a node on purpose: the relations table keeps it and `spec check` owns
// BROKEN_RELATES.

import type { RelationRow } from "@spec-engine/shared";

function reqSeq(reqId: string): number {
  const parts = reqId.split("-");
  if (parts.length < 2) return 0;
  const n = Number.parseInt(parts[1] ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/** Numeric seq: BILLING-9 sorts before BILLING-10, which lexicographic would not. */
function compareReqIds(a: string, b: string): number {
  const keyCmp = (a.split("-")[0] ?? "").localeCompare(b.split("-")[0] ?? "");
  if (keyCmp !== 0) return keyCmp;
  const seqCmp = reqSeq(a) - reqSeq(b);
  if (seqCmp !== 0) return seqCmp;
  return a.localeCompare(b);
}

export function sortRelations(rows: RelationRow[]): RelationRow[] {
  return [...rows].sort(
    (a, b) => compareReqIds(a.from_id, b.from_id) || compareReqIds(a.to_id, b.to_id),
  );
}

/** `-` is unsafe in a bare flowchart node id (it collides with the `---` edge
 *  syntax). Ids match `[A-Z][A-Z0-9]*-\d+`, so the substitution cannot collide. */
function nodeId(reqId: string): string {
  return reqId.replace(/[^A-Za-z0-9_]/g, "_");
}

export function renderRelations(rows: RelationRow[], mode: "mermaid" | "json"): string {
  const sorted = sortRelations(rows);

  if (mode === "json") {
    return JSON.stringify(sorted);
  }

  const ids = Array.from(new Set(sorted.flatMap((r) => [r.from_id, r.to_id]))).sort(compareReqIds);

  // Relates is associative: A→B and B→A are one fact, so each pair is
  // canonicalized to (low, high) before dedupe.
  const edgeKeys = new Set<string>();
  const edges: Array<[string, string]> = [];
  for (const r of sorted) {
    const [lo, hi] =
      compareReqIds(r.from_id, r.to_id) <= 0 ? [r.from_id, r.to_id] : [r.to_id, r.from_id];
    const key = `${lo}\x00${hi}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push([lo, hi]);
  }
  edges.sort((a, b) => compareReqIds(a[0], b[0]) || compareReqIds(a[1], b[1]));

  const lines = ["graph LR"];
  for (const id of ids) lines.push(`  ${nodeId(id)}["${id}"]`);
  for (const [lo, hi] of edges) lines.push(`  ${nodeId(lo)} --- ${nodeId(hi)}`);
  return lines.join("\n");
}
