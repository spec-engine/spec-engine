// packages/engine/test/proven.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec PROOF-002 unit
//
// GATE-02 unit cases for the pure `provenDetermination()` detector +
// `proofsUnconfirmedWarning()`. Drives the functions directly with synthetic
// Requirement[] + Tag[] + TestCaseResult[] — no Storage, no bun:sqlite, no
// fixtures. PROVEN is a check-time projection: ≥1 verifying tag whose test
// PASSED → PROVEN → no diagnostic; otherwise ONE error-severity UNPROVEN_REQ.
// A req with NO verifying tag is Q4/Q5's business (no double-diagnosis).

import { describe, expect, test } from "bun:test";
import type { Requirement, RequirementStatus, Tag } from "@spec-engine/shared";
import { proofsUnconfirmedWarning, provenDetermination } from "../src/check/proven";
import type { TestCaseResult } from "../src/results/junit";

function mkReq(over: Partial<Requirement>): Requirement {
  return {
    id: "BILLING-009",
    key: "BILLING",
    seq: 9,
    status: "Active",
    superseded_by: null,
    text: "",
    why: null,
    source_file: "spec-engine/BILLING/SPEC.md",
    line: 42,
    spec_version: 1,
    changed_at_version: 1,
    superseded_at_version: null,
    ...over,
  };
}

function mkTag(over: Partial<Tag>): Tag {
  return {
    id: 1,
    req_id: "BILLING-009",
    repo: "api",
    file: "api/test/renew.e2e.test.ts",
    line: 10,
    kind: "verifies",
    level: "e2e",
    ...over,
  };
}

function mkResult(over: Partial<TestCaseResult>): TestCaseResult {
  return {
    file: "api/test/renew.e2e.test.ts",
    name: "renews on charge",
    line: null,
    status: "pass",
    ...over,
  };
}

describe("provenDetermination() (GATE-02)", () => {
  test("empty inputs → empty array", () => {
    expect(provenDetermination([], [], [])).toEqual([]);
  });

  test("PROVEN: verifying tag whose file is green → NO diagnostic", () => {
    const reqs = [mkReq({})];
    const tags = [mkTag({})];
    const results = [mkResult({ status: "pass" })];
    expect(provenDetermination(reqs, tags, results)).toEqual([]);
  });

  test("verifying tag whose file has a <failure> → one UNPROVEN_REQ (error)", () => {
    const reqs = [mkReq({})];
    const tags = [mkTag({})];
    const results = [mkResult({ status: "fail" })];
    const out = provenDetermination(reqs, tags, results);
    expect(out.length).toBe(1);
    const d = out[0];
    expect(d?.code).toBe("UNPROVEN_REQ");
    expect(d?.severity).toBe("error");
    expect(d?.repo).toBe(null);
    expect(d?.req_id).toBe("BILLING-009");
    expect(d?.source_file).toBe("spec-engine/BILLING/SPEC.md");
    expect(d?.line).toBe(42);
    expect(d?.detail).toContain("BILLING-009");
  });

  test("verifying tag whose file is ABSENT from results → one UNPROVEN_REQ", () => {
    const reqs = [mkReq({})];
    const tags = [mkTag({})];
    const results = [mkResult({ file: "other/unrelated.test.ts", status: "pass" })];
    const out = provenDetermination(reqs, tags, results);
    expect(out.length).toBe(1);
    expect(out[0]?.req_id).toBe("BILLING-009");
  });

  test("verifying tag whose only correlated testcase is <skipped> → one UNPROVEN_REQ", () => {
    const reqs = [mkReq({})];
    const tags = [mkTag({})];
    const results = [mkResult({ status: "skip" })];
    expect(provenDetermination(reqs, tags, results).length).toBe(1);
  });

  test("TWO verifying tags, one passing → PROVEN → NO diagnostic (≥1 pass suffices)", () => {
    const reqs = [mkReq({})];
    const tags = [
      mkTag({ id: 1, file: "api/test/renew.e2e.test.ts" }),
      mkTag({ id: 2, file: "api/test/renew.unit.test.ts" }),
    ];
    const results = [
      mkResult({ file: "api/test/renew.e2e.test.ts", status: "fail" }),
      mkResult({ file: "api/test/renew.unit.test.ts", status: "pass" }),
    ];
    expect(provenDetermination(reqs, tags, results)).toEqual([]);
  });

  test("req with NO verifying tag → NO UNPROVEN_REQ (Q4/Q5 own it, no double-diagnosis)", () => {
    const reqs = [mkReq({ id: "BILLING-009" })];
    // tags belong to a DIFFERENT req → the req under test has zero verifying tags
    const tags = [mkTag({ req_id: "OTHER-001" })];
    const results = [mkResult({ status: "fail" })];
    expect(provenDetermination(reqs, tags, results)).toEqual([]);
  });

  test("a tag whose kind is not 'verifies' does not count as a verifying tag", () => {
    const reqs = [mkReq({})];
    // an 'implements' tag for the same req is NOT a verifying tag → zero
    // verifying tags → no UNPROVEN_REQ (Q4/Q5 own it).
    const tags = [mkTag({ kind: "implements" })];
    const results = [mkResult({ status: "fail" })];
    expect(provenDetermination(reqs, tags, results)).toEqual([]);
  });

  test("non-active (Superseded/Draft/Retired) req → never emits UNPROVEN_REQ", () => {
    const reqs = [
      mkReq({ id: "BILLING-001", status: "Superseded" as RequirementStatus }),
      mkReq({ id: "X-002", status: "Draft" as RequirementStatus }),
      mkReq({ id: "X-003", status: "Retired" as RequirementStatus }),
    ];
    const tags = [
      mkTag({ req_id: "BILLING-001" }),
      mkTag({ req_id: "X-002" }),
      mkTag({ req_id: "X-003" }),
    ];
    const results = [mkResult({ status: "fail" })];
    expect(provenDetermination(reqs, tags, results)).toEqual([]);
  });

  test("one UNPROVEN_REQ per unproven req (multiple reqs)", () => {
    const reqs = [
      mkReq({ id: "BILLING-009", source_file: "spec-engine/BILLING/SPEC.md", line: 42 }),
      mkReq({ id: "BILLING-010", source_file: "spec-engine/BILLING/SPEC.md", line: 50 }),
    ];
    const tags = [
      mkTag({ req_id: "BILLING-009", file: "api/test/a.test.ts" }),
      mkTag({ req_id: "BILLING-010", file: "api/test/b.test.ts" }),
    ];
    // a green, b failing → only BILLING-010 flags
    const results = [
      mkResult({ file: "api/test/a.test.ts", status: "pass" }),
      mkResult({ file: "api/test/b.test.ts", status: "fail" }),
    ];
    const out = provenDetermination(reqs, tags, results);
    expect(out.length).toBe(1);
    expect(out[0]?.req_id).toBe("BILLING-010");
  });

  test("output is NOT pre-sorted (insertion order preserved)", () => {
    const reqs = [
      mkReq({ id: "ZZZ-001", source_file: "spec-engine/ZZZ/SPEC.md" }),
      mkReq({ id: "AAA-001", source_file: "spec-engine/AAA/SPEC.md" }),
    ];
    const tags = [
      mkTag({ req_id: "ZZZ-001", file: "api/test/z.test.ts" }),
      mkTag({ req_id: "AAA-001", file: "api/test/a.test.ts" }),
    ];
    const results: TestCaseResult[] = []; // both absent → both unproven
    const out = provenDetermination(reqs, tags, results);
    expect(out.map((d) => d.req_id)).toEqual(["ZZZ-001", "AAA-001"]);
  });

  test("does not mutate its inputs", () => {
    const reqs = [mkReq({})];
    const tags = [mkTag({})];
    const results = [mkResult({ status: "fail" })];
    const reqSnap = JSON.stringify(reqs);
    const tagSnap = JSON.stringify(tags);
    const resSnap = JSON.stringify(results);
    provenDetermination(reqs, tags, results);
    expect(JSON.stringify(reqs)).toBe(reqSnap);
    expect(JSON.stringify(tags)).toBe(tagSnap);
    expect(JSON.stringify(results)).toBe(resSnap);
  });
});

describe("proofsUnconfirmedWarning() (GATE-05)", () => {
  test("returns exactly one warning-severity PROOFS_UNCONFIRMED with null locators", () => {
    const d = proofsUnconfirmedWarning();
    expect(d.code).toBe("PROOFS_UNCONFIRMED");
    expect(d.severity).toBe("warning");
    expect(d.repo).toBe(null);
    expect(d.req_id).toBe(null);
    expect(d.source_file).toBe(null);
    expect(d.line).toBe(null);
    expect(d.detail).toContain("--results");
  });
});
