// packages/engine/src/relations/format.ts
//
// RED-17: pure formatter for the Relates entity diagram. Takes
// RelationRow[] in (from storage.listRelations()), returns string out —
// mermaid `graph LR` source or a JSON projection. No I/O, no Storage, no
// bun:sqlite. Both the CLI (commands/relations.ts) and the HTTP seam
// (server/api.ts `/api/relations?format=mermaid`) render through THIS
// function, so the two surfaces cannot drift (Invariant: one engine, not
// two). The webapp page reads the mermaid text via the API because its
// import fence (D-09) forbids importing @spec-engine/spec-check directly.
//
// Mermaid shape decisions:
//   - `graph LR` (flowchart), NOT `erDiagram` — requirements relate
//     associatively; ER cardinality syntax has no meaning here.
//   - Node ids are sanitized (hyphen → underscore) because `-` is unsafe
//     in bare flowchart node ids (it collides with edge syntax `---`);
//     the ORIGINAL requirement id is kept as the bracket label.
//   - Edges are UNDIRECTED (`---`) and deduplicated as unordered pairs:
//     Relates is an associative link, so A→B and B→A are the same fact.
//     Each pair is canonicalized to (low, high) order before dedupe.
//   - Broken targets (a Relates to an id that doesn't exist) still render
//     as nodes — the relations table deliberately keeps them (Invariant
//     #4) and `spec check` owns the BROKEN_RELATES diagnostic.
//   - Deterministic: nodes and edges are sorted with the same
//     domain-then-numeric-seq comparator as map/format.ts, so output is
//     byte-stable across runs (snapshot-testable, MAP-02 discipline).
//
// D-08 grep-fence: this file does not import bun:sqlite.

import type { RelationRow } from "@spec-engine/shared";

/**
 * Parse the numeric sequence suffix from a requirement id like
 * "BILLING-009" → 9. Mirrors map/format.ts's reqSeq — falls back to 0 for
 * ids without a parseable suffix (defensive; ID_RE-filtered ids always
 * have one).
 */
function reqSeq(reqId: string): number {
  const parts = reqId.split("-");
  if (parts.length < 2) return 0;
  const n = Number.parseInt(parts[1] ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compare two requirement ids by (domain key ASC, seq numeric ASC).
 * BILLING-9 sorts before BILLING-10 — lexicographic compare would not.
 */
function compareReqIds(a: string, b: string): number {
  const keyCmp = (a.split("-")[0] ?? "").localeCompare(b.split("-")[0] ?? "");
  if (keyCmp !== 0) return keyCmp;
  const seqCmp = reqSeq(a) - reqSeq(b);
  if (seqCmp !== 0) return seqCmp;
  return a.localeCompare(b);
}

/**
 * Deterministically sort relation rows by (from_id, to_id) using the
 * domain-aware comparator. Returns a NEW array — never mutates input.
 */
export function sortRelations(rows: RelationRow[]): RelationRow[] {
  return [...rows].sort(
    (a, b) => compareReqIds(a.from_id, b.from_id) || compareReqIds(a.to_id, b.to_id),
  );
}

/** Mermaid-safe node id: requirement ids match ID_RE
 *  (`[A-Z][A-Z0-9]*-\d+`), so replacing the hyphen with an underscore is
 *  collision-free within that universe. */
function nodeId(reqId: string): string {
  return reqId.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Render the Relates graph. Always sorts via sortRelations first.
 *
 * mode="json": JSON.stringify(sorted) — full RelationRow shape (including
 *   source_file/line), byte-stable for machine consumers.
 *
 * mode="mermaid": a `graph LR` block — node declarations first (each
 *   distinct id once, sorted), then deduped undirected edges (sorted).
 *   Empty input → bare "graph LR" (a valid, empty diagram). No trailing
 *   newline (the CLI's console.log adds one).
 */
export function renderRelations(rows: RelationRow[], mode: "mermaid" | "json"): string {
  const sorted = sortRelations(rows);

  if (mode === "json") {
    return JSON.stringify(sorted);
  }

  // Distinct ids across both endpoints, sorted — one node declaration each.
  const ids = Array.from(new Set(sorted.flatMap((r) => [r.from_id, r.to_id]))).sort(compareReqIds);

  // Canonicalize each edge to (low, high) and dedupe — A→B and B→A are
  // the same associative fact and must render as ONE undirected edge.
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
