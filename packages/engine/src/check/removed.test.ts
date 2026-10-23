// @spec CHCK-023 unit
import { describe, expect, test } from "bun:test";
import type { SpecRequirement } from "@spec-engine/shared";
import { requirementRemoved } from "./removed";

function mkReq(over: Partial<SpecRequirement> & { id: string }): SpecRequirement {
  return {
    status: "Active",
    statement: "s",
    why: null,
    supersedes: null,
    supersededBy: null,
    relates: [],
    issues: [],
    ...over,
  } as SpecRequirement;
}

const relPath = (_id: string): string | null => "spec-engine/BILLING/SPEC.json";

describe("requirementRemoved()", () => {
  test("empty inputs → empty array", () => {
    expect(requirementRemoved([], [], relPath)).toEqual([]);
  });

  test("id present in both base and change → no diagnostic", () => {
    const base = [mkReq({ id: "BILLING-001" }), mkReq({ id: "BILLING-002" })];
    const change = [mkReq({ id: "BILLING-001" }), mkReq({ id: "BILLING-002" })];
    expect(requirementRemoved(base, change, relPath)).toEqual([]);
  });

  test("base id absent from change with no successor → one error REQUIREMENT_REMOVED", () => {
    const base = [mkReq({ id: "BILLING-002" })];
    const change: SpecRequirement[] = [];
    const out = requirementRemoved(base, change, relPath);
    expect(out.length).toBe(1);
    expect(out[0]?.code).toBe("REQUIREMENT_REMOVED");
    expect(out[0]?.severity).toBe("error");
    expect(out[0]?.req_id).toBe("BILLING-002");
    expect(out[0]?.line).toBe(0);
    expect(out[0]?.source_file).toBe("spec-engine/BILLING/SPEC.json");
  });

  test("exemption direction (a): base.supersededBy survives in change → no diagnostic", () => {
    const base = [mkReq({ id: "BILLING-001", supersededBy: "BILLING-009" })];
    const change = [mkReq({ id: "BILLING-009" })];
    expect(requirementRemoved(base, change, relPath)).toEqual([]);
  });

  test("exemption direction (b): a surviving successor declares supersedes === removed id → no diagnostic", () => {
    const base = [mkReq({ id: "BILLING-001" })];
    const change = [mkReq({ id: "BILLING-009", supersedes: "BILLING-001" })];
    expect(requirementRemoved(base, change, relPath)).toEqual([]);
  });

  test("supersededBy points at an id that did NOT survive → still fires", () => {
    const base = [mkReq({ id: "BILLING-001", supersededBy: "BILLING-099" })];
    const change: SpecRequirement[] = [];
    const out = requirementRemoved(base, change, relPath);
    expect(out.length).toBe(1);
    expect(out[0]?.req_id).toBe("BILLING-001");
  });

  test("detector returns UNSORTED — order follows base iteration order", () => {
    const base = [mkReq({ id: "BILLING-020" }), mkReq({ id: "BILLING-003" })];
    const change: SpecRequirement[] = [];
    const out = requirementRemoved(base, change, relPath);
    expect(out.map((d) => d.req_id)).toEqual(["BILLING-020", "BILLING-003"]);
  });
});
