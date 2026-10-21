import { describe, expect, test } from "bun:test";
import type { RelationRow } from "@spec-engine/shared";
import { renderRelations, sortRelations } from "./format";

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
      "AUTH-2>AUTH-9",
      "AUTH-2>AUTH-10",
      "AUTH-2>BILLING-9",
      "BILLING-2>AUTH-1",
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
    expect(lines).toContain('  REL_1["REL-1"]');
    expect(lines).toContain('  REL_2["REL-2"]');
    expect(lines).toContain('  REL_3["REL-3"]');
    expect(out.match(/REL_3\["REL-3"\]/g)?.length).toBe(1);
  });

  test("emits one undirected edge per unordered pair, in canonical (low, high) order", () => {
    const out = renderRelations([rel("REL-3", "REL-2"), rel("REL-1", "REL-3")], "mermaid");
    const lines = out.split("\n");
    expect(lines).toContain("  REL_1 --- REL_3");
    expect(lines).toContain("  REL_2 --- REL_3");
    expect(out).not.toContain("REL_3 --- REL_2");
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
