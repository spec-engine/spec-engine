// packages/engine/test/check-removed.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec GUARD-010 unit
//
// GOV-01 unit cases for the pure `requirementRemoved()` detector. Drives the
// function directly with hand-built SpecRequirement[] — no git, no Storage, no
// bun:sqlite, no fixtures. REQUIREMENT_REMOVED is a check-time projection: a
// base id absent from the change with no approved supersession → ONE
// error-severity diagnostic. An approved supersession in EITHER direction
// (base.supersededBy survives, OR a survivor declares supersedes === removed id)
// exempts it. The detector returns UNSORTED — format.ts owns ordering.

import { describe, expect, test } from "bun:test";
import type { SpecRequirement } from "@spec-engine/shared";
import { requirementRemoved } from "../src/check/removed";

function mkReq(over: Partial<SpecRequirement> & { id: string }): SpecRequirement {
  return {
    status: "Active",
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

const relPath = (_id: string): string | null => "spec-engine/BILLING/SPEC.json";

describe("requirementRemoved() (GOV-01)", () => {
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
    expect(out[0].code).toBe("REQUIREMENT_REMOVED");
    expect(out[0].severity).toBe("error");
    expect(out[0].req_id).toBe("BILLING-002");
    expect(out[0].line).toBe(0);
    expect(out[0].source_file).toBe("spec-engine/BILLING/SPEC.json");
  });

  test("exemption direction (a): base.supersededBy survives in change → no diagnostic", () => {
    // BILLING-001 removed, but its base row was supersededBy BILLING-009 which survives.
    const base = [mkReq({ id: "BILLING-001", supersededBy: "BILLING-009" })];
    const change = [mkReq({ id: "BILLING-009" })];
    expect(requirementRemoved(base, change, relPath)).toEqual([]);
  });

  test("exemption direction (b): a surviving successor declares supersedes === removed id → no diagnostic", () => {
    // BILLING-001 removed; BILLING-009 survives and declares supersedes: BILLING-001.
    const base = [mkReq({ id: "BILLING-001" })];
    const change = [mkReq({ id: "BILLING-009", supersedes: "BILLING-001" })];
    expect(requirementRemoved(base, change, relPath)).toEqual([]);
  });

  test("supersededBy points at an id that did NOT survive → still fires", () => {
    const base = [mkReq({ id: "BILLING-001", supersededBy: "BILLING-099" })];
    const change: SpecRequirement[] = [];
    const out = requirementRemoved(base, change, relPath);
    expect(out.length).toBe(1);
    expect(out[0].req_id).toBe("BILLING-001");
  });

  test("detector returns UNSORTED — order follows base iteration order", () => {
    const base = [mkReq({ id: "BILLING-020" }), mkReq({ id: "BILLING-003" })];
    const change: SpecRequirement[] = [];
    const out = requirementRemoved(base, change, relPath);
    expect(out.map((d) => d.req_id)).toEqual(["BILLING-020", "BILLING-003"]);
  });
});
