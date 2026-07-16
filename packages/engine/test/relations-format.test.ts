// packages/engine/test/relations-format.test.ts
//
// RED-17: pure-formatter tests for the Relates → mermaid entity diagram
// (relations/format.ts). Mirrors map.test.ts's posture: RelationRow[] in,
// string out — no I/O, no Storage, no bun:sqlite (D-08).
//
// Contract under test:
//   - sortRelations: deterministic (from domain, from seq, to domain,
//     to seq) ordering; returns a NEW array, never mutates input.
//   - renderRelations(rows, "json"): JSON.stringify(sorted) — byte-stable
//     regardless of input order.
//   - renderRelations(rows, "mermaid"): a `graph LR` block with one node
//     declaration per distinct id (mermaid-safe node ids, original id as
//     the bracket label) and one UNDIRECTED edge per unordered (a, b)
//     pair — symmetric duplicates (A→B and B→A) collapse to one edge.
//   - Empty input → "graph LR" (a valid, empty mermaid diagram) / "[]".

import { describe, expect, test } from "bun:test";
import type { RelationRow } from "@spec-engine/shared";
import { renderRelations, sortRelations } from "../src/relations/format";

/** RelationRow factory — source_file/line are carried through JSON mode
 *  but irrelevant to the mermaid projection. */
function rel(from: string, to: string, line = 1): RelationRow {
  return { from_id: from, to_id: to, source_file: "spec-engine/X/SPEC.md", line };
}

describe("sortRelations", () => {
  test("sorts by (from domain, from seq numeric, to domain, to seq numeric)", () => {
    const input = [
      rel("BILLING-10", "AUTH-1"),
      rel("AUTH-2", "BILLING-9"),
      rel("BILLING-2", "AUTH-1"),
      rel("AUTH-2", "AUTH-10"),
      rel("AUTH-2", "AUTH-9"),
    ];
    const sorted = sortRelations(input);
    expect(sorted.map((r) => `${r.from_id}>${r.to_id}`)).toEqual([
      "AUTH-2>AUTH-9", // seq 9 before seq 10 — numeric, not lexicographic
      "AUTH-2>AUTH-10",
      "AUTH-2>BILLING-9",
      "BILLING-2>AUTH-1", // BILLING-2 before BILLING-10 — numeric
      "BILLING-10>AUTH-1",
    ]);
  });

  test("returns a new array and never mutates the input", () => {
    const input = [rel("B-2", "A-1"), rel("A-1", "B-2")];
    const snapshot = input.map((r) => `${r.from_id}>${r.to_id}`);
    const sorted = sortRelations(input);
    expect(sorted).not.toBe(input);
    expect(input.map((r) => `${r.from_id}>${r.to_id}`)).toEqual(snapshot);
  });
});

describe("renderRelations — json mode", () => {
  test("empty input → '[]'", () => {
    expect(renderRelations([], "json")).toBe("[]");
  });

  test("byte-stable: same rows in different input order produce identical output", () => {
    const a = [rel("REL-1", "REL-3"), rel("REL-3", "REL-2")];
    const b = [rel("REL-3", "REL-2"), rel("REL-1", "REL-3")];
    expect(renderRelations(a, "json")).toBe(renderRelations(b, "json"));
    // Full row shape survives the JSON projection (source_file + line).
    const parsed = JSON.parse(renderRelations(a, "json")) as RelationRow[];
    expect(parsed[0]).toEqual(rel("REL-1", "REL-3"));
  });
});

describe("renderRelations — mermaid mode", () => {
  test("empty input → bare 'graph LR' header (valid empty diagram)", () => {
    expect(renderRelations([], "mermaid")).toBe("graph LR");
  });

  test("declares each distinct id once with a mermaid-safe node id and the original id as label", () => {
    const out = renderRelations([rel("REL-1", "REL-3"), rel("REL-3", "REL-2")], "mermaid");
    const lines = out.split("\n");
    expect(lines[0]).toBe("graph LR");
    // Hyphens are not safe in bare mermaid node ids — sanitized to _.
    expect(lines).toContain('  REL_1["REL-1"]');
    expect(lines).toContain('  REL_2["REL-2"]');
    expect(lines).toContain('  REL_3["REL-3"]');
    // Each node declared exactly once even though REL-3 appears in two rows.
    expect(out.match(/REL_3\["REL-3"\]/g)?.length).toBe(1);
  });

  test("emits one undirected edge per unordered pair, in canonical (low, high) order", () => {
    // Stored direction is REL-3 → REL-2; the diagram canonicalizes to
    // (REL-2, REL-3) so symmetric inputs always render identically.
    const out = renderRelations([rel("REL-3", "REL-2"), rel("REL-1", "REL-3")], "mermaid");
    const lines = out.split("\n");
    expect(lines).toContain("  REL_1 --- REL_3");
    expect(lines).toContain("  REL_2 --- REL_3");
    expect(out).not.toContain("REL_3 --- REL_2");
    // Edges come after all node declarations, deterministically sorted.
    expect(lines.indexOf("  REL_1 --- REL_3")).toBeGreaterThan(lines.indexOf('  REL_3["REL-3"]'));
    expect(lines.indexOf("  REL_1 --- REL_3")).toBeLessThan(lines.indexOf("  REL_2 --- REL_3"));
  });

  test("symmetric duplicates (A→B and B→A) collapse to a single edge", () => {
    const out = renderRelations([rel("REL-1", "REL-2"), rel("REL-2", "REL-1")], "mermaid");
    expect(out.match(/ --- /g)?.length).toBe(1);
    expect(out).toContain("  REL_1 --- REL_2");
  });

  test("exact duplicate rows collapse to a single edge", () => {
    const out = renderRelations([rel("REL-1", "REL-2", 3), rel("REL-1", "REL-2", 9)], "mermaid");
    expect(out.match(/ --- /g)?.length).toBe(1);
  });

  test("byte-stable: same rows in different input order produce identical output", () => {
    const a = [rel("REL-1", "REL-3"), rel("REL-3", "REL-2"), rel("REL-2", "REL-1")];
    const b = [rel("REL-2", "REL-1"), rel("REL-1", "REL-3"), rel("REL-3", "REL-2")];
    expect(renderRelations(a, "mermaid")).toBe(renderRelations(b, "mermaid"));
  });
});
