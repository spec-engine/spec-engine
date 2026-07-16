// packages/engine/test/map.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec MAP-001
//
// Pure-function tests for map/format.ts (MAP-01 / MAP-02). No I/O, no
// Storage, no DB — just sortMatrix / cellStatus / renderMatrix exercised
// over hand-rolled CoverageRow fixtures.
//
// JSON-mode determinism is asserted strictly (byte-equal across two calls).
// Text-mode is asserted loosely via substring checks — column padding is
// hand-rolled and not part of the MAP-02 contract.

import { describe, expect, test } from "bun:test";
import type { CoverageRow } from "@spec-engine/shared";
import { cellStatus, renderMatrix, sortMatrix } from "../src/map/format";

function row(over: Partial<CoverageRow>): CoverageRow {
  return {
    req_id: "AUTH-001",
    domain_key: "AUTH",
    req_status: "Active",
    req_spec_version: 1,
    req_changed_at_version: 1,
    repo: "api",
    repo_pin: 1,
    implemented: 0,
    verified: 0,
    test_levels: null,
    ...over,
  };
}

describe("sortMatrix", () => {
  test("sorts numerically by req seq within a domain (BILLING-009 vs BILLING-010)", () => {
    const input: CoverageRow[] = [
      row({ req_id: "BILLING-010", domain_key: "BILLING", repo: "api" }),
      row({ req_id: "BILLING-009", domain_key: "BILLING", repo: "api" }),
      row({ req_id: "BILLING-002", domain_key: "BILLING", repo: "api" }),
    ];
    const sorted = sortMatrix(input);
    expect(sorted.map((r) => r.req_id)).toEqual(["BILLING-002", "BILLING-009", "BILLING-010"]);
  });

  test("sorts by domain_key first, all AUTH before all BILLING", () => {
    const input: CoverageRow[] = [
      row({ req_id: "BILLING-001", domain_key: "BILLING", repo: "api" }),
      row({ req_id: "AUTH-001", domain_key: "AUTH", repo: "api" }),
      row({ req_id: "BILLING-002", domain_key: "BILLING", repo: "api" }),
      row({ req_id: "AUTH-002", domain_key: "AUTH", repo: "api" }),
    ];
    const sorted = sortMatrix(input);
    expect(sorted.map((r) => r.domain_key)).toEqual(["AUTH", "AUTH", "BILLING", "BILLING"]);
  });

  test("sorts by repo within (domain, req) — admin < api < mobile alphabetically", () => {
    const input: CoverageRow[] = [
      row({ req_id: "AUTH-001", domain_key: "AUTH", repo: "mobile" }),
      row({ req_id: "AUTH-001", domain_key: "AUTH", repo: "admin" }),
      row({ req_id: "AUTH-001", domain_key: "AUTH", repo: "api" }),
    ];
    const sorted = sortMatrix(input);
    expect(sorted.map((r) => r.repo)).toEqual(["admin", "api", "mobile"]);
  });

  test("does not mutate input array", () => {
    const input: CoverageRow[] = [
      row({ req_id: "BILLING-009", domain_key: "BILLING", repo: "api" }),
      row({ req_id: "BILLING-002", domain_key: "BILLING", repo: "api" }),
    ];
    const snapshot = input.map((r) => r.req_id);
    sortMatrix(input);
    expect(input.map((r) => r.req_id)).toEqual(snapshot);
  });
});

describe("cellStatus", () => {
  test("implemented=1 verified=1 → 'src+test'", () => {
    expect(cellStatus(row({ implemented: 1, verified: 1 }))).toBe("src+test");
  });
  test("implemented=1 verified=0 → 'src'", () => {
    expect(cellStatus(row({ implemented: 1, verified: 0 }))).toBe("src");
  });
  test("implemented=0 verified=1 → 'test'", () => {
    expect(cellStatus(row({ implemented: 0, verified: 1 }))).toBe("test");
  });
  test("implemented=0 verified=0 → '—' (em-dash U+2014)", () => {
    expect(cellStatus(row({ implemented: 0, verified: 0 }))).toBe("—");
  });
});

describe("renderMatrix", () => {
  test("--json output is byte-identical across two consecutive calls", () => {
    const input: CoverageRow[] = [
      row({ req_id: "BILLING-009", domain_key: "BILLING", repo: "mobile", implemented: 1 }),
      row({ req_id: "AUTH-001", domain_key: "AUTH", repo: "api", implemented: 1, verified: 1 }),
      row({ req_id: "BILLING-002", domain_key: "BILLING", repo: "admin" }),
    ];
    const a = renderMatrix(input, "json");
    const b = renderMatrix(input, "json");
    expect(a).toBe(b);
    // And the contents must be a JSON array — quick sanity check.
    expect(Array.isArray(JSON.parse(a))).toBe(true);
  });

  test("text format includes header tokens DOMAIN, REQUIREMENT, STATUS", () => {
    const input: CoverageRow[] = [
      row({ req_id: "AUTH-001", domain_key: "AUTH", repo: "api", implemented: 1, verified: 1 }),
    ];
    const out = renderMatrix(input, "text");
    expect(out).toContain("DOMAIN");
    expect(out).toContain("REQUIREMENT");
    expect(out).toContain("STATUS");
  });

  test("text format renders em-dash for empty cells", () => {
    const input: CoverageRow[] = [
      row({ req_id: "AUTH-001", domain_key: "AUTH", repo: "api", implemented: 0, verified: 0 }),
    ];
    const out = renderMatrix(input, "text");
    expect(out).toContain("—");
  });

  test("empty input → JSON '[]' and text returns a string (possibly just header)", () => {
    expect(renderMatrix([], "json")).toBe("[]");
    // text mode: empty rows means no repos to discover → no columns. We
    // document the behavior as 'returns a string'; either an empty string
    // or a header-only line is acceptable.
    const text = renderMatrix([], "text");
    expect(typeof text).toBe("string");
  });
});
