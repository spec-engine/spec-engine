// @spec OWNER-002 unit
import { describe, expect, test } from "bun:test";
import type { SpecRequirement } from "@spec-engine/shared";
import type { CodeownersRule } from "./codeowners";
import { unapprovedStatusFlip } from "./statusflip";

function mkReq(over: Partial<SpecRequirement> & { id: string }): SpecRequirement {
  return {
    status: "active",
    statement: "s",
    why: null,
    supersedes: null,
    supersededBy: null,
    relates: [],
    issues: [],
    ...over,
  } as SpecRequirement;
}

const codeowners: CodeownersRule[] = [{ pattern: "spec-engine/BILLING/", owners: ["@drea"] }];
const relPath = (_id: string): string | null => "spec-engine/BILLING/SPEC.json";

describe("unapprovedStatusFlip()", () => {
  test("empty inputs → empty array", () => {
    expect(unapprovedStatusFlip([], [], codeowners, [], relPath, false)).toEqual([]);
  });

  test("active → superseded flip, empty approvedBy, default → ONE warning", () => {
    const base = [mkReq({ id: "BILLING-001", status: "active" })];
    const change = [mkReq({ id: "BILLING-001", status: "superseded" })];
    const out = unapprovedStatusFlip(base, change, codeowners, [], relPath, false);
    expect(out.length).toBe(1);
    expect(out[0]?.code).toBe("UNAPPROVED_STATUS_FLIP");
    expect(out[0]?.severity).toBe("warning");
    expect(out[0]?.req_id).toBe("BILLING-001");
    expect(out[0]?.line).toBe(0);
    expect(out[0]?.source_file).toBe("spec-engine/BILLING/SPEC.json");
  });

  test("approver handle matches the CODEOWNERS owner case-insensitively", () => {
    const base = [mkReq({ id: "BILLING-001", status: "active" })];
    const change = [mkReq({ id: "BILLING-001", status: "superseded" })];
    expect(unapprovedStatusFlip(base, change, codeowners, ["@Drea"], relPath, true)).toEqual([]);
    expect(unapprovedStatusFlip(base, change, codeowners, ["DREA"], relPath, true)).toEqual([]);
  });

  test("SAME flip under strict=true → ONE error (two-tier severity)", () => {
    const base = [mkReq({ id: "BILLING-001", status: "active" })];
    const change = [mkReq({ id: "BILLING-001", status: "superseded" })];
    const out = unapprovedStatusFlip(base, change, codeowners, [], relPath, true);
    expect(out.length).toBe(1);
    expect(out[0]?.severity).toBe("error");
  });

  test("draft → retired flip also fires", () => {
    const base = [mkReq({ id: "BILLING-002", status: "draft" })];
    const change = [mkReq({ id: "BILLING-002", status: "retired" })];
    const out = unapprovedStatusFlip(base, change, codeowners, [], relPath, false);
    expect(out.length).toBe(1);
    expect(out[0]?.severity).toBe("warning");
  });

  test("empty approvedBy → fail-closed (flip fires)", () => {
    const base = [mkReq({ id: "BILLING-001", status: "active" })];
    const change = [mkReq({ id: "BILLING-001", status: "superseded" })];
    expect(unapprovedStatusFlip(base, change, codeowners, [], relPath, false).length).toBe(1);
  });

  test("an approver matching a CODEOWNERS owner (@ normalized) → silent in BOTH modes", () => {
    const base = [mkReq({ id: "BILLING-001", status: "active" })];
    const change = [mkReq({ id: "BILLING-001", status: "superseded" })];
    expect(unapprovedStatusFlip(base, change, codeowners, ["drea"], relPath, false)).toEqual([]);
    expect(unapprovedStatusFlip(base, change, codeowners, ["drea"], relPath, true)).toEqual([]);
    expect(unapprovedStatusFlip(base, change, codeowners, ["@drea"], relPath, true)).toEqual([]);
  });

  test("change status OUTSIDE {superseded, retired} (planted BAD_STATUS) → NO diagnostic", () => {
    const base = [mkReq({ id: "BILLING-001", status: "active" })];
    const change = [mkReq({ id: "BILLING-001", status: "drft" })];
    expect(unapprovedStatusFlip(base, change, codeowners, [], relPath, false)).toEqual([]);
  });

  test("already superseded in base → not a NEW flip → silent", () => {
    const base = [mkReq({ id: "BILLING-001", status: "superseded" })];
    const change = [mkReq({ id: "BILLING-001", status: "superseded" })];
    expect(unapprovedStatusFlip(base, change, codeowners, [], relPath, false)).toEqual([]);
  });

  test("already retired in base → superseded in change → silent (base already terminal)", () => {
    const base = [mkReq({ id: "BILLING-001", status: "retired" })];
    const change = [mkReq({ id: "BILLING-001", status: "superseded" })];
    expect(unapprovedStatusFlip(base, change, codeowners, [], relPath, false)).toEqual([]);
  });

  test("detail names the id, the target status, and the owners", () => {
    const base = [mkReq({ id: "BILLING-001", status: "active" })];
    const change = [mkReq({ id: "BILLING-001", status: "superseded" })];
    const out = unapprovedStatusFlip(base, change, codeowners, [], relPath, false);
    expect(out[0]?.detail).toContain("BILLING-001");
    expect(out[0]?.detail).toContain("superseded");
    expect(out[0]?.detail).toContain("@drea");
  });

  test("detector returns UNSORTED — order follows change iteration order", () => {
    const base = [
      mkReq({ id: "BILLING-020", status: "active" }),
      mkReq({ id: "BILLING-003", status: "active" }),
    ];
    const change = [
      mkReq({ id: "BILLING-020", status: "superseded" }),
      mkReq({ id: "BILLING-003", status: "retired" }),
    ];
    const out = unapprovedStatusFlip(base, change, codeowners, [], relPath, false);
    expect(out.map((d) => d.req_id)).toEqual(["BILLING-020", "BILLING-003"]);
  });
});
