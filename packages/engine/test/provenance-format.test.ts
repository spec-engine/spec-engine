// packages/engine/test/provenance-format.test.ts
//
// PMAT-01 / PMAT-02: pure-formatter tests for the provenance matrix
// (provenance/format.ts). Mirrors relations-format.test.ts's posture:
// ProvenanceMatrixRow[] in, string out — no I/O, no Storage, no bun:sqlite
// (D-08).
//
// Contract under test:
//   - sortProvenance: deterministic ordering on the FULL composite key
//     (req_id via domain-then-numeric-seq, then role, then issue_id, then
//     source_file, then line) — BILLING-9 sorts before BILLING-10, and a
//     synthetic amends-via row sorts deterministically among created /
//     supersedes-via rows for the same requirement. Returns a NEW array,
//     never mutates input. The key MUST match the Plan 01 storage ORDER BY
//     so JSON is byte-stable across cold rebuilds (PMAT-02 / Pitfall 2).
//   - renderProvenance(rows, "json") === JSON.stringify(sortProvenance(rows))
//     — no indentation, no trailing newline.
//   - renderProvenance(rows, "text"): a per-requirement human view carrying,
//     per link, the req_id, the role label, the opaque issue_id, and the
//     source_file:line git pointer.
//   - Empty input → "[]" (json) / "" (text).

import { describe, expect, test } from "bun:test";
import type { ProvenanceMatrixRow } from "@spec-engine/shared";
import { renderProvenance, sortProvenance } from "../src/provenance/format";

/** ProvenanceMatrixRow factory — backing-test columns default to a plausible
 *  "implemented & verified, unit+integration" link; override per-test. */
function prov(
  req_id: string,
  role: string,
  issue_id: string,
  opts: Partial<ProvenanceMatrixRow> = {},
): ProvenanceMatrixRow {
  return {
    req_id,
    role,
    issue_id,
    source_file: opts.source_file ?? "spec-engine/BILLING/SPEC.md",
    line: opts.line ?? 1,
    req_status: opts.req_status ?? "Active",
    implemented: opts.implemented ?? 1,
    verified: opts.verified ?? 1,
    test_levels: opts.test_levels ?? "unit,integration",
  };
}

describe("sortProvenance", () => {
  test("sorts on the full composite key (req_id numeric-seq, role, issue_id, source_file, line)", () => {
    const input = [
      prov("BILLING-10", "created", "ENG-100"),
      prov("BILLING-9", "supersedes-via", "ENG-7"),
      prov("BILLING-9", "amends-via", "ENG-9999", { line: 4 }),
      prov("BILLING-9", "created", "ENG-1"),
      prov("BILLING-9", "amends-via", "ENG-9999", { line: 2 }),
    ];
    const sorted = sortProvenance(input);
    expect(sorted.map((r) => `${r.req_id}:${r.role}:${r.issue_id}@${r.line}`)).toEqual([
      // BILLING-9 (seq 9) before BILLING-10 (seq 10) — numeric, not lexicographic.
      // Within BILLING-9: role ASC (amends-via < created < supersedes-via),
      // then issue_id, then source_file, then line.
      "BILLING-9:amends-via:ENG-9999@2",
      "BILLING-9:amends-via:ENG-9999@4",
      "BILLING-9:created:ENG-1@1",
      "BILLING-9:supersedes-via:ENG-7@1",
      "BILLING-10:created:ENG-100@1",
    ]);
  });

  test("returns a new array and never mutates the input", () => {
    const input = [prov("B-2", "created", "ENG-2"), prov("A-1", "created", "ENG-1")];
    const snapshot = input.map((r) => r.req_id);
    const sorted = sortProvenance(input);
    expect(sorted).not.toBe(input);
    expect(input.map((r) => r.req_id)).toEqual(snapshot);
  });
});

describe("renderProvenance — json mode", () => {
  test("empty input → '[]'", () => {
    expect(renderProvenance([], "json")).toBe("[]");
  });

  test("renderProvenance(rows, 'json') === JSON.stringify(sortProvenance(rows)) — no chrome", () => {
    const rows = [
      prov("BILLING-9", "supersedes-via", "ENG-7"),
      prov("BILLING-9", "amends-via", "ENG-9999"),
      prov("BILLING-9", "created", "ENG-1"),
    ];
    const out = renderProvenance(rows, "json");
    expect(out).toBe(JSON.stringify(sortProvenance(rows)));
    // No pretty-printing: no newline / no 2-space indentation artifacts.
    expect(out).not.toContain("\n");
    expect(out.startsWith("[")).toBe(true);
    // Full row shape survives the JSON projection.
    const parsed = JSON.parse(out) as ProvenanceMatrixRow[];
    expect(parsed[0]?.test_levels).toBe("unit,integration");
  });

  test("byte-stable: same rows in different input order produce identical output", () => {
    const a = [prov("BILLING-9", "created", "ENG-1"), prov("BILLING-10", "created", "ENG-2")];
    const b = [prov("BILLING-10", "created", "ENG-2"), prov("BILLING-9", "created", "ENG-1")];
    expect(renderProvenance(a, "json")).toBe(renderProvenance(b, "json"));
  });
});

describe("renderProvenance — text mode", () => {
  test("empty input → '' (no rows, no requirements to render)", () => {
    expect(renderProvenance([], "text")).toBe("");
  });

  test("carries req_id, role label, opaque issue_id, and source_file:line per link (incl. amends-via)", () => {
    const rows = [
      prov("BILLING-9", "created", "ENG-1432", {
        source_file: "spec-engine/BILLING/SPEC.md",
        line: 12,
      }),
      prov("BILLING-9", "supersedes-via", "ENG-7", {
        source_file: "spec-engine/BILLING/SPEC.md",
        line: 13,
      }),
      // Synthetic amends-via row — no fixture seeding (Pitfall 5(a)).
      prov("BILLING-9", "amends-via", "ENG-9999", {
        source_file: "spec-engine/BILLING/SPEC.md",
        line: 14,
      }),
    ];
    const out = renderProvenance(rows, "text");
    // Requirement id present.
    expect(out).toContain("BILLING-9");
    // Each role label present.
    expect(out).toContain("created");
    expect(out).toContain("supersedes-via");
    expect(out).toContain("amends-via");
    // Opaque issue ids present (rendered verbatim — never resolved).
    expect(out).toContain("ENG-1432");
    expect(out).toContain("ENG-7");
    expect(out).toContain("ENG-9999");
    // Git pointer rendered as source_file:line.
    expect(out).toContain("spec-engine/BILLING/SPEC.md:12");
    expect(out).toContain("spec-engine/BILLING/SPEC.md:14");
  });
});
