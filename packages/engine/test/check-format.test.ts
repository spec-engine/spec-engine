// packages/engine/test/check-format.test.ts
//
// Pure-function tests for the diagnostic formatter (CHCK-02 / CHCK-04 sort
// determinism). No filesystem, no DB — just hand-rolled Diagnostic[]
// arrays exercising the sort comparator and the text + JSON output shapes.

import { describe, expect, test } from "bun:test";
import type { Diagnostic } from "@spec-engine/shared";
import { renderDiagnostics, sortDiagnostics } from "../src/check/format";

const D = (overrides: Partial<Diagnostic>): Diagnostic => ({
  code: "DANGLING_TAG",
  source_file: "x/y.ts",
  line: 1,
  repo: "x",
  req_id: "KEY-001",
  detail: "detail",
  severity: "error",
  ...overrides,
});

describe("sortDiagnostics — composite sort key", () => {
  test("orderless input is returned sorted by (code, repo NULLS LAST, source_file, line)", () => {
    const input: Diagnostic[] = [
      D({
        code: "UNVERIFIED_REQ",
        repo: null,
        source_file: "spec-engine/B/SPEC.md",
        line: 19,
        req_id: "BILLING-002",
      }),
      D({
        code: "DRIFT",
        repo: "mobile",
        source_file: "mobile/src/billing.ts",
        line: 1,
        req_id: "BILLING-001",
      }),
      D({
        code: "DANGLING_TAG",
        repo: "admin",
        source_file: "admin/src/reports.ts",
        line: 2,
        req_id: "BILLING-999",
      }),
      D({
        code: "ORPHAN_REQ",
        repo: null,
        source_file: "spec-engine/A/SPEC.md",
        line: 7,
        req_id: "AUTH-001",
      }),
      D({
        code: "SUPERSEDED_REFERENCED",
        repo: "mobile",
        source_file: "mobile/src/billing.ts",
        line: 1,
        req_id: "BILLING-001",
      }),
    ];
    const sorted = sortDiagnostics(input);
    expect(sorted.map((d) => d.code)).toEqual([
      "DANGLING_TAG",
      "DRIFT",
      "ORPHAN_REQ",
      "SUPERSEDED_REFERENCED",
      "UNVERIFIED_REQ",
    ]);
  });

  test("repo NULLS LAST: non-null repo sorts BEFORE null repo for same code", () => {
    const input: Diagnostic[] = [
      D({ code: "DRIFT", repo: null, req_id: "X" }),
      D({ code: "DRIFT", repo: "admin", req_id: "Y" }),
    ];
    const sorted = sortDiagnostics(input);
    expect(sorted[0]?.repo).toBe("admin");
    expect(sorted[1]?.repo).toBeNull();
  });

  // RED-14 dead-end audit: the comparator's tie-break branches (same code →
  // repo cmp; same repo → source_file cmp; same file → line cmp) existed
  // without a covering test.
  test("same code: two non-null repos sort alphabetically (RED-14)", () => {
    const input: Diagnostic[] = [
      D({ code: "DRIFT", repo: "mobile", source_file: "m.ts", line: 1 }),
      D({ code: "DRIFT", repo: "admin", source_file: "a.ts", line: 1 }),
    ];
    const sorted = sortDiagnostics(input);
    expect(sorted.map((d) => d.repo)).toEqual(["admin", "mobile"]);
  });

  test("same code + same repo: source_file ASC decides (RED-14)", () => {
    const input: Diagnostic[] = [
      D({ code: "DRIFT", repo: "api", source_file: "z/late.ts", line: 1 }),
      D({ code: "DRIFT", repo: "api", source_file: "a/early.ts", line: 9 }),
    ];
    const sorted = sortDiagnostics(input);
    expect(sorted.map((d) => d.source_file)).toEqual(["a/early.ts", "z/late.ts"]);
  });

  test("same code + repo + source_file: line ASC decides, null line first (RED-14)", () => {
    const input: Diagnostic[] = [
      D({ code: "DRIFT", repo: "api", source_file: "same.ts", line: 7 }),
      D({ code: "DRIFT", repo: "api", source_file: "same.ts", line: null }),
      D({ code: "DRIFT", repo: "api", source_file: "same.ts", line: 3 }),
    ];
    const sorted = sortDiagnostics(input);
    expect(sorted.map((d) => d.line)).toEqual([null, 3, 7]);
  });

  // WR-01 (Phase 14) determinism hardening: rows that collide on every prior
  // key (code, repo, source_file, line) must order deterministically by
  // req_id, independent of caller input order. UNSOURCED_CHANGE rows share
  // code + repo:null, so this tie-break is what keeps a second engine caller
  // (e.g. the webapp) from emitting unstable output.
  test("same code + repo + source_file + line: req_id ASC decides (WR-01)", () => {
    const a = D({
      code: "UNSOURCED_CHANGE" as Diagnostic["code"],
      repo: null,
      source_file: "spec-engine/SHARED/SPEC.md",
      line: 0,
      req_id: "BILLING-001",
    });
    const b = D({
      code: "UNSOURCED_CHANGE" as Diagnostic["code"],
      repo: null,
      source_file: "spec-engine/SHARED/SPEC.md",
      line: 0,
      req_id: "AUTH-009",
    });
    // Both input orders must yield the same req_id ordering.
    expect(sortDiagnostics([a, b]).map((d) => d.req_id)).toEqual(["AUTH-009", "BILLING-001"]);
    expect(sortDiagnostics([b, a]).map((d) => d.req_id)).toEqual(["AUTH-009", "BILLING-001"]);
  });

  test("null req_id sorts before a non-null req_id on otherwise-equal keys (WR-01)", () => {
    const input: Diagnostic[] = [
      D({ code: "DRIFT", repo: "api", source_file: "same.ts", line: 1, req_id: "Z-1" }),
      D({ code: "DRIFT", repo: "api", source_file: "same.ts", line: 1, req_id: null }),
    ];
    const sorted = sortDiagnostics(input);
    expect(sorted.map((d) => d.req_id)).toEqual([null, "Z-1"]);
  });

  test("does NOT mutate input array", () => {
    const input: Diagnostic[] = [
      D({ code: "ZZZ" as Diagnostic["code"] }),
      D({ code: "AAA" as Diagnostic["code"] }),
    ];
    const inputCopy = [...input];
    sortDiagnostics(input);
    expect(input).toEqual(inputCopy);
  });
});

describe("renderDiagnostics — JSON mode", () => {
  test("round-trip JSON parse yields an array of rows with expected keys", () => {
    const rows: Diagnostic[] = [D({ code: "DANGLING_TAG", repo: "admin", req_id: "BILLING-999" })];
    const json = renderDiagnostics(rows, "json");
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({
      code: "DANGLING_TAG",
      repo: "admin",
      req_id: "BILLING-999",
      severity: "error",
    });
  });

  test("empty input → '[]'", () => {
    expect(renderDiagnostics([], "json")).toBe("[]");
  });

  test("no whitespace in serialized output (deterministic byte form)", () => {
    const rows: Diagnostic[] = [D({})];
    const json = renderDiagnostics(rows, "json");
    // JSON.stringify with no spaces argument has no `\n` or `  ` indentation.
    expect(json).not.toContain("\n");
    expect(json).not.toContain("  ");
  });
});

describe("renderDiagnostics — text mode", () => {
  test("single row renders tab-separated: CODE\\trepo\\tfile:line\\treq_id\\tdetail", () => {
    const rows: Diagnostic[] = [
      D({
        code: "DANGLING_TAG",
        repo: "admin",
        source_file: "admin/src/reports.ts",
        line: 2,
        req_id: "BILLING-999",
        detail: "Tag references non-existent requirement BILLING-999",
      }),
    ];
    const text = renderDiagnostics(rows, "text");
    expect(text).toBe(
      "DANGLING_TAG\tadmin\tadmin/src/reports.ts:2\tBILLING-999\tTag references non-existent requirement BILLING-999",
    );
  });

  test("orphan row (repo null) renders as adjacent tabs, no literal 'null'", () => {
    const rows: Diagnostic[] = [
      D({
        code: "ORPHAN_REQ",
        repo: null,
        source_file: "spec-engine/AUTH/SPEC.md",
        line: 7,
        req_id: "AUTH-001",
        detail: "Active requirement AUTH-001 has no implementing tag",
      }),
    ];
    const text = renderDiagnostics(rows, "text");
    // The two tabs around the empty repo field must be adjacent: `code\t\tfile:line\t...`.
    expect(text).toContain("ORPHAN_REQ\t\tspec-engine/AUTH/SPEC.md:7\tAUTH-001\t");
    expect(text).not.toContain("null");
  });

  test("empty input → empty string", () => {
    expect(renderDiagnostics([], "text")).toBe("");
  });

  test("multi-row output joined with newline, no trailing newline", () => {
    const rows: Diagnostic[] = [
      D({ code: "DANGLING_TAG", repo: "admin", req_id: "X-1" }),
      D({ code: "DRIFT", repo: "mobile", req_id: "Y-1" }),
    ];
    const text = renderDiagnostics(rows, "text");
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(text.endsWith("\n")).toBe(false);
  });
});
