// packages/engine/test/unsourced.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INDX-002 unit
//
// USRC-01 / USRC-03 unit cases for the pure `unsourcedChanges()` detector.
// Drives the function directly with synthetic Requirement[] + ProvenanceRow[]
// inputs — no Storage, no bun:sqlite, no fixtures. This is the off-by-default
// seam: the function is a side-effect-free projection over already-fetched
// rows, so it cannot perturb build_id / the cold-rebuild smokes / the 6-row
// inverted-CI baseline.

import { describe, expect, test } from "bun:test";
import type { ProvenanceRow, Requirement, RequirementStatus } from "@spec-engine/shared";
import { unsourcedChanges } from "../src/check/unsourced";

// Cloned from diagnostics.test.ts mkReq — synthetic Requirement builder.
function mkReq(over: Partial<Requirement>): Requirement {
  return {
    id: "X-001",
    key: "X",
    seq: 1,
    status: "Active",
    superseded_by: null,
    text: "",
    why: null,
    source_file: "spec-engine/X/SPEC.md",
    line: 7,
    spec_version: 1,
    changed_at_version: 1,
    superseded_at_version: null,
    ...over,
  };
}

function mkProv(over: Partial<ProvenanceRow>): ProvenanceRow {
  return {
    req_id: "X-001",
    issue_id: "ENG-1",
    role: "created",
    source_file: "spec-engine/X/SPEC.md",
    line: 8,
    ...over,
  };
}

describe("unsourcedChanges() unit cases (USRC-01/03)", () => {
  test("empty inputs → empty array", () => {
    expect(unsourcedChanges([], [])).toEqual([]);
  });

  test("Superseded req WITHOUT a supersedes-via row of its own id → one warning", () => {
    const reqs = [
      mkReq({
        id: "BILLING-001",
        status: "Superseded" as RequirementStatus,
        superseded_by: "BILLING-009",
        source_file: "spec-engine/BILLING/SPEC.md",
        line: 42,
      }),
    ];
    const out = unsourcedChanges(reqs, []);
    expect(out.length).toBe(1);
    const d = out[0];
    expect(d?.code).toBe("UNSOURCED_CHANGE");
    expect(d?.severity).toBe("warning");
    expect(d?.repo).toBe(null);
    expect(d?.req_id).toBe("BILLING-001");
    expect(d?.source_file).toBe("spec-engine/BILLING/SPEC.md");
    expect(d?.line).toBe(42);
    expect(d?.detail).toContain("BILLING-001");
  });

  test("Superseded req WITH a supersedes-via row of its OWN id → no row", () => {
    const reqs = [
      mkReq({
        id: "BILLING-001",
        status: "Superseded" as RequirementStatus,
        superseded_by: "BILLING-009",
      }),
    ];
    const prov = [mkProv({ req_id: "BILLING-001", role: "supersedes-via", issue_id: "ENG-42" })];
    expect(unsourcedChanges(reqs, prov)).toEqual([]);
  });

  test("supersedes-via keyed on the SUCCESSOR's id does NOT clear the superseded req (A1)", () => {
    // The successor BILLING-009 carries supersedes-via — but that does NOT
    // source the superseded BILLING-001. Only BILLING-001's OWN provenance
    // clears it. So BILLING-001 still flags.
    const reqs = [
      mkReq({
        id: "BILLING-001",
        status: "Superseded" as RequirementStatus,
        superseded_by: "BILLING-009",
      }),
    ];
    const prov = [mkProv({ req_id: "BILLING-009", role: "supersedes-via", issue_id: "ENG-42" })];
    const out = unsourcedChanges(reqs, prov);
    expect(out.length).toBe(1);
    expect(out[0]?.req_id).toBe("BILLING-001");
  });

  test("Active req (even with no provenance) → never flagged", () => {
    const reqs = [mkReq({ id: "BILLING-009", status: "Active" })];
    expect(unsourcedChanges(reqs, [])).toEqual([]);
  });

  test("Draft / Retired reqs → never flagged (status guard)", () => {
    const reqs = [
      mkReq({ id: "X-002", status: "Draft" as RequirementStatus }),
      mkReq({ id: "X-003", status: "Retired" as RequirementStatus }),
    ];
    expect(unsourcedChanges(reqs, [])).toEqual([]);
  });

  test("a non-supersedes-via role of the superseded req does NOT clear it", () => {
    const reqs = [
      mkReq({
        id: "BILLING-001",
        status: "Superseded" as RequirementStatus,
      }),
    ];
    // 'created' role of the same id is not a supersedes-via — still flags.
    const prov = [mkProv({ req_id: "BILLING-001", role: "created" })];
    expect(unsourcedChanges(reqs, prov).length).toBe(1);
  });

  test("does not mutate its inputs", () => {
    const reqs = [mkReq({ id: "BILLING-001", status: "Superseded" as RequirementStatus })];
    const prov: ProvenanceRow[] = [];
    const reqSnap = JSON.stringify(reqs);
    const provSnap = JSON.stringify(prov);
    unsourcedChanges(reqs, prov);
    expect(JSON.stringify(reqs)).toBe(reqSnap);
    expect(JSON.stringify(prov)).toBe(provSnap);
  });
});
