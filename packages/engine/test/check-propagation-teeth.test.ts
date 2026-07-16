// packages/engine/test/check-propagation-teeth.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec PROOF-007 unit
//
// PROP-01 unit cases for the pure `changedRules()` + `partialPropagation()`
// detectors. Drives the functions directly with hand-built SpecRequirement[] /
// Tag[] / TestCaseResult[] — no git, no Storage, no bun:sqlite, no fixtures.
//
// `changedRules` = the base→change content/changedAtVersion diff.
// `partialPropagation` = for a CHANGED active rule with ≥2 verifying tags, the
// MIXED `anyPass && !allPass` case → ONE error PARTIAL_PROPAGATION. All-pass is
// silent; all-fail is left to UNPROVEN_REQ (no double-diagnosis). Reuses
// `correlateTag` from check/proven.ts. The detector returns UNSORTED.

import { describe, expect, test } from "bun:test";
import type { SpecRequirement, Tag } from "@spec-engine/shared";
import { changedRules, partialPropagation } from "../src/check/propagation-teeth";
import type { TestCaseResult } from "../src/results/junit";

function mkReq(over: Partial<SpecRequirement> & { id: string }): SpecRequirement {
  return {
    status: "active",
    statement: "s",
    why: null,
    supersedes: null,
    supersededBy: null,
    relates: [],
    livesIn: [],
    issues: [],
    ...over,
  } as SpecRequirement;
}

let tagId = 0;
function mkTag(over: Partial<Tag> & { req_id: string; file: string }): Tag {
  return {
    id: ++tagId,
    repo: "api",
    line: 1,
    kind: "verifies",
    level: null,
    ...over,
  } as Tag;
}

function mkResult(over: Partial<TestCaseResult> & { file: string }): TestCaseResult {
  return { name: "t", line: null, status: "pass", ...over } as TestCaseResult;
}

const relPath = (_id: string): string | null => "spec-engine/BILLING/SPEC.json";

describe("changedRules() (PROP-01 base diff)", () => {
  test("statement differs → included", () => {
    const base = [mkReq({ id: "BILLING-007", statement: "old" })];
    const change = [mkReq({ id: "BILLING-007", statement: "new" })];
    expect(changedRules(base, change).map((r) => r.id)).toEqual(["BILLING-007"]);
  });

  test("changedAtVersion differs → included", () => {
    const base = [mkReq({ id: "BILLING-007", changedAtVersion: 1 })];
    const change = [mkReq({ id: "BILLING-007", changedAtVersion: 2 })];
    expect(changedRules(base, change).map((r) => r.id)).toEqual(["BILLING-007"]);
  });

  test("identical statement + changedAtVersion → EXCLUDED (unchanged)", () => {
    const base = [mkReq({ id: "BILLING-007", statement: "same", changedAtVersion: 3 })];
    const change = [mkReq({ id: "BILLING-007", statement: "same", changedAtVersion: 3 })];
    expect(changedRules(base, change)).toEqual([]);
  });

  test("id only in change (no base match) → EXCLUDED", () => {
    const base: SpecRequirement[] = [];
    const change = [mkReq({ id: "BILLING-099", statement: "new" })];
    expect(changedRules(base, change)).toEqual([]);
  });
});

describe("partialPropagation() (PROP-01)", () => {
  // BILLING-007's two bound sites (the cart-vs-invoice partial-update analog).
  const passTag = mkTag({ req_id: "BILLING-007", file: "api/test/tax.test.ts" });
  const failTag = mkTag({ req_id: "BILLING-007", file: "admin/test/reports.int.test.ts" });

  test("mixed: one passing + one failing verifying tag → ONE error PARTIAL_PROPAGATION", () => {
    const changed = [mkReq({ id: "BILLING-007", status: "active" })];
    const results = [
      mkResult({ file: "api/test/tax.test.ts", status: "pass" }),
      mkResult({ file: "admin/test/reports.int.test.ts", status: "fail" }),
    ];
    const out = partialPropagation(changed, [passTag, failTag], results, relPath);
    expect(out.length).toBe(1);
    expect(out[0].code).toBe("PARTIAL_PROPAGATION");
    expect(out[0].severity).toBe("error");
    expect(out[0].req_id).toBe("BILLING-007");
    expect(out[0].line).toBe(0);
    expect(out[0].source_file).toBe("spec-engine/BILLING/SPEC.json");
  });

  test("all-pass → silent (fully propagated)", () => {
    const changed = [mkReq({ id: "BILLING-007", status: "active" })];
    const results = [
      mkResult({ file: "api/test/tax.test.ts", status: "pass" }),
      mkResult({ file: "admin/test/reports.int.test.ts", status: "pass" }),
    ];
    expect(partialPropagation(changed, [passTag, failTag], results, relPath)).toEqual([]);
  });

  test("all-fail → silent (UNPROVEN_REQ territory — no double-diagnosis)", () => {
    const changed = [mkReq({ id: "BILLING-007", status: "active" })];
    const results = [
      mkResult({ file: "api/test/tax.test.ts", status: "fail" }),
      mkResult({ file: "admin/test/reports.int.test.ts", status: "fail" }),
    ];
    expect(partialPropagation(changed, [passTag, failTag], results, relPath)).toEqual([]);
  });

  test("<2 verifying tags → silent ('partial' needs ≥2 bound sites)", () => {
    const changed = [mkReq({ id: "BILLING-007", status: "active" })];
    const results = [mkResult({ file: "api/test/tax.test.ts", status: "pass" })];
    expect(partialPropagation(changed, [passTag], results, relPath)).toEqual([]);
  });

  test("non-verifies tags do not count toward the ≥2 threshold", () => {
    const implTag = mkTag({
      req_id: "BILLING-007",
      file: "api/src/tax.ts",
      kind: "implements",
    });
    const changed = [mkReq({ id: "BILLING-007", status: "active" })];
    const results = [
      mkResult({ file: "api/test/tax.test.ts", status: "pass" }),
      mkResult({ file: "admin/test/reports.int.test.ts", status: "fail" }),
    ];
    // Only one verifying tag (passTag) + a non-verifying implTag → below threshold.
    expect(partialPropagation(changed, [passTag, implTag], results, relPath)).toEqual([]);
  });

  test("non-active changed rule → silent (exact raw-status match)", () => {
    const changed = [mkReq({ id: "BILLING-007", status: "superseded" })];
    const results = [
      mkResult({ file: "api/test/tax.test.ts", status: "pass" }),
      mkResult({ file: "admin/test/reports.int.test.ts", status: "fail" }),
    ];
    expect(partialPropagation(changed, [passTag, failTag], results, relPath)).toEqual([]);
  });
});
