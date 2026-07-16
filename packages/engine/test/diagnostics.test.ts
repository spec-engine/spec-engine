// packages/engine/test/diagnostics.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INDX-002 unit
//
// PARS-02 mechanical assertion: DUP_ID, BROKEN_SUPERSEDE, and BAD_STATUS
// are captured at parse time AND the offending requirement row still
// lands in the DB (Invariant #4).
//
// Unit-level: drive `validateStructure(specs)` directly with synthetic
// ParsedSpec inputs.
// End-to-end: run the full `runIndex` pipeline against three test-only
// fixtures under packages/engine/test/fixtures/diagnostics/ — one per
// structural code. The canonical platform-fixture stays clean.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IndexResult, Requirement, RequirementStatus } from "@spec-engine/shared";
import { validateStructure } from "../src/indexer/diagnostics";
import { runIndex } from "../src/indexer/pipeline";
import type { ParsedSpec } from "../src/parser/types";
import { openStorage } from "../src/storage/sqlite";

const FIXTURES_ROOT = resolve(import.meta.dir, "fixtures", "diagnostics");

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

function mkSpec(over: Partial<ParsedSpec> & { requirements: Requirement[] }): ParsedSpec {
  return {
    key: "X",
    owner: "drea",
    schema: null,
    spec_version: 1,
    updated: null,
    // RED-16: relations default empty; structural validation does not
    // consume them (Relates diagnostics are semantic, Q6/Q7 in sqlite.ts).
    relations: [],
    // T5: surfaced self-references default empty (SELF_RELATES pass).
    self_relates: [],
    // PROV-01/05: provenance + unknown-role tokens default empty.
    provenance: [],
    unknown_roles: [],
    // TERM-01 (Phase 6): term-store collections default empty (Wave C flatten).
    term_aliases: [],
    term_citations: [],
    ...over,
  };
}

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-diag-test-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// --- Unit tests over validateStructure ------------------------------------

describe("validateStructure unit cases", () => {
  test("empty input → empty output", () => {
    expect(validateStructure([])).toEqual([]);
  });

  test("DUP_ID emits one diagnostic per duplicate occurrence after the first", () => {
    const specs = [
      mkSpec({
        requirements: [
          mkReq({ id: "X-001", line: 7 }),
          mkReq({ id: "X-001", line: 12, source_file: "spec-engine/X/SPEC.md" }),
        ],
      }),
    ];
    const out = validateStructure(specs);
    const dups = out.filter((d) => d.code === "DUP_ID");
    expect(dups.length).toBe(1);
    expect(dups[0]?.line).toBe(12);
    expect(dups[0]?.detail).toContain("X-001");
    expect(dups[0]?.detail).toContain(":7"); // first-seen location
    expect(dups[0]?.severity).toBe("error");
  });

  test("BROKEN_SUPERSEDE emits when superseded_by points to a missing id", () => {
    const specs = [
      mkSpec({
        requirements: [
          mkReq({
            id: "Y-001",
            status: "Superseded" as RequirementStatus,
            superseded_by: "Y-999",
          }),
        ],
      }),
    ];
    const out = validateStructure(specs);
    const broken = out.filter((d) => d.code === "BROKEN_SUPERSEDE");
    expect(broken.length).toBe(1);
    expect(broken[0]?.detail).toContain("Y-001");
    expect(broken[0]?.detail).toContain("Y-999");
    expect(broken[0]?.severity).toBe("error");
  });

  test("BROKEN_SUPERSEDE does NOT fire when target exists in the parsed set", () => {
    const specs = [
      mkSpec({
        requirements: [
          mkReq({
            id: "X-001",
            status: "Superseded" as RequirementStatus,
            superseded_by: "X-002",
          }),
          mkReq({ id: "X-002", line: 12 }),
        ],
      }),
    ];
    const out = validateStructure(specs);
    expect(out.filter((d) => d.code === "BROKEN_SUPERSEDE")).toEqual([]);
  });

  test("BAD_STATUS emits when status is not one of the four valid literals", () => {
    const specs = [
      mkSpec({
        requirements: [
          // Cast to RequirementStatus (matches what the parser does for
          // Invalid raw statuses — Pitfall 3).
          mkReq({ id: "Z-001", status: "Drft" as RequirementStatus }),
        ],
      }),
    ];
    const out = validateStructure(specs);
    const bad = out.filter((d) => d.code === "BAD_STATUS");
    expect(bad.length).toBe(1);
    expect(bad[0]?.detail).toContain("Z-001");
    expect(bad[0]?.detail).toContain("Drft");
    expect(bad[0]?.severity).toBe("error");
  });

  test("BAD_STATUS does NOT fire for Active/Superseded/Draft/Retired", () => {
    const specs = [
      mkSpec({
        requirements: [
          mkReq({ id: "X-001", status: "Active" }),
          mkReq({ id: "X-002", status: "Draft" }),
          mkReq({ id: "X-003", status: "Retired" }),
          mkReq({ id: "X-004", status: "Superseded", superseded_by: "X-001" }),
        ],
      }),
    ];
    const out = validateStructure(specs);
    expect(out.filter((d) => d.code === "BAD_STATUS")).toEqual([]);
  });

  test("input array is not mutated", () => {
    const reqs = [mkReq({ id: "X-001" }), mkReq({ id: "X-001", line: 99 })];
    const specs = [mkSpec({ requirements: reqs })];
    const snapshot = JSON.stringify(specs);
    validateStructure(specs);
    expect(JSON.stringify(specs)).toBe(snapshot);
  });
});

// --- End-to-end tests over the runIndex pipeline --------------------------

describe("runIndex against test-only diagnostic fixtures (PARS-02 end-to-end)", () => {
  test("DUP_ID: diagnostic captured AND the offending row lands in requirements", async () => {
    const platformDir = join(FIXTURES_ROOT, "dup-id");
    const s = openStorage(dbPath);
    let result: IndexResult | undefined;
    try {
      result = await runIndex({ platformDir, storage: s });
    } finally {
      s.close();
    }

    expect(result.diagnostics).toBeGreaterThanOrEqual(1);

    const db = new Database(dbPath, { readonly: true });
    try {
      const diagRows = db
        .query("SELECT code, source_file FROM parse_diagnostics WHERE code='DUP_ID'")
        .all() as Array<{ code: string; source_file: string }>;
      expect(diagRows.length).toBeGreaterThanOrEqual(1);
      expect(diagRows[0]?.source_file).toBe("spec-engine/X/SPEC.json");

      // Invariant #4: the offending requirement row STILL lands. With
      // INSERT OR REPLACE on PK collision, the second occurrence wins —
      // exactly one row for X-001 must exist.
      const reqRows = db
        .query("SELECT id, source_file FROM requirements WHERE id='X-001'")
        .all() as Array<{ id: string; source_file: string }>;
      expect(reqRows.length).toBe(1);
      expect(reqRows[0]?.id).toBe("X-001");
    } finally {
      db.close();
    }
  });

  test("BROKEN_SUPERSEDE: diagnostic captured AND Y-001 still lands with superseded_by=Y-999", async () => {
    const platformDir = join(FIXTURES_ROOT, "broken-supersede");
    const s = openStorage(dbPath);
    let result: IndexResult | undefined;
    try {
      result = await runIndex({ platformDir, storage: s });
    } finally {
      s.close();
    }

    expect(result.diagnostics).toBeGreaterThanOrEqual(1);

    const db = new Database(dbPath, { readonly: true });
    try {
      const diagRows = db
        .query("SELECT code, source_file FROM parse_diagnostics WHERE code='BROKEN_SUPERSEDE'")
        .all() as Array<{ code: string; source_file: string }>;
      expect(diagRows.length).toBe(1);
      expect(diagRows[0]?.source_file).toBe("spec-engine/Y/SPEC.json");

      const reqRow = db
        .query("SELECT id, superseded_by FROM requirements WHERE id='Y-001'")
        .get() as { id: string; superseded_by: string | null } | null;
      expect(reqRow).not.toBeNull();
      expect(reqRow?.superseded_by).toBe("Y-999");
    } finally {
      db.close();
    }
  });

  test("BAD_STATUS: diagnostic captured AND Z-001 still lands with status='drft'", async () => {
    const platformDir = join(FIXTURES_ROOT, "bad-status");
    const s = openStorage(dbPath);
    let result: IndexResult | undefined;
    try {
      result = await runIndex({ platformDir, storage: s });
    } finally {
      s.close();
    }

    expect(result.diagnostics).toBeGreaterThanOrEqual(1);

    const db = new Database(dbPath, { readonly: true });
    try {
      const diagRows = db
        .query("SELECT code, source_file, detail FROM parse_diagnostics WHERE code='BAD_STATUS'")
        .all() as Array<{ code: string; source_file: string; detail: string }>;
      expect(diagRows.length).toBe(1);
      expect(diagRows[0]?.source_file).toBe("spec-engine/Z/SPEC.json");
      // Migrate (18-03) lowercases status VERBATIM (Q-invariant: bad status must
      // lowercase, not normalize to a valid enum) so the planted "Drft" migrates
      // to "drft" — BAD_STATUS still fires on the unknown token.
      expect(diagRows[0]?.detail).toContain("drft");

      const reqRow = db.query("SELECT id, status FROM requirements WHERE id='Z-001'").get() as {
        id: string;
        status: string;
      } | null;
      expect(reqRow).not.toBeNull();
      // Verbatim raw (now lowercased) status survives all the way to the DB.
      expect(reqRow?.status).toBe("drft");
    } finally {
      db.close();
    }
  });
});

// ----------------------------------------------------------------------------
// Audit hygiene pass T5 — SELF_RELATES: a Relates token naming its own
// requirement is authored noise; the parser drops it from `relations` but
// surfaces it, and validateStructure turns it into a warning (consistent
// with how every other authoring mistake gets a code).
// ----------------------------------------------------------------------------

describe("validateStructure — SELF_RELATES (T5)", () => {
  test("one warning per surfaced self-reference, at the Relates line", () => {
    const specs = [
      mkSpec({
        requirements: [mkReq({ id: "X-001", line: 7 })],
        self_relates: [{ req_id: "X-001", source_file: "spec-engine/X/SPEC.md", line: 9 }],
      }),
    ];
    const out = validateStructure(specs);
    const self = out.filter((d) => d.code === "SELF_RELATES");
    expect(self.length).toBe(1);
    expect(self[0]?.req_id).toBe("X-001");
    expect(self[0]?.source_file).toBe("spec-engine/X/SPEC.md");
    expect(self[0]?.line).toBe(9);
    expect(self[0]?.severity).toBe("warning");
    expect(self[0]?.detail).toContain("X-001");
  });

  test("no self_relates entries → no SELF_RELATES diagnostics", () => {
    const specs = [mkSpec({ requirements: [mkReq({})], self_relates: [] })];
    expect(validateStructure(specs).filter((d) => d.code === "SELF_RELATES")).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Audit hygiene pass T6 — CYCLIC_SUPERSEDE: a circular supersession chain
// (A→B→A, or A→A) is corrupt change history. Previously it was never
// diagnosed — the propagation CTE just stops at depth 16, silently. Error
// severity, matching the other structural chain defects (BROKEN_SUPERSEDE).
// ----------------------------------------------------------------------------

describe("validateStructure — CYCLIC_SUPERSEDE (T6)", () => {
  test("two-node cycle emits one error per requirement in the cycle", () => {
    const specs = [
      mkSpec({
        requirements: [
          mkReq({
            id: "X-001",
            line: 7,
            status: "Superseded" as RequirementStatus,
            superseded_by: "X-002",
          }),
          mkReq({
            id: "X-002",
            line: 12,
            status: "Superseded" as RequirementStatus,
            superseded_by: "X-001",
          }),
        ],
      }),
    ];
    const out = validateStructure(specs).filter((d) => d.code === "CYCLIC_SUPERSEDE");
    expect(out.length).toBe(2);
    expect(out.map((d) => d.req_id).sort()).toEqual(["X-001", "X-002"]);
    for (const d of out) {
      expect(d.severity).toBe("error");
      expect(d.detail).toContain("X-001");
      expect(d.detail).toContain("X-002");
    }
  });

  test("self-supersession (A superseded by A) is a one-node cycle", () => {
    const specs = [
      mkSpec({
        requirements: [
          mkReq({
            id: "X-001",
            status: "Superseded" as RequirementStatus,
            superseded_by: "X-001",
          }),
        ],
      }),
    ];
    const out = validateStructure(specs).filter((d) => d.code === "CYCLIC_SUPERSEDE");
    expect(out.length).toBe(1);
    expect(out[0]?.req_id).toBe("X-001");
    expect(out[0]?.severity).toBe("error");
  });

  test("an acyclic chain (A→B→C) emits nothing", () => {
    const specs = [
      mkSpec({
        requirements: [
          mkReq({
            id: "X-001",
            status: "Superseded" as RequirementStatus,
            superseded_by: "X-002",
          }),
          mkReq({
            id: "X-002",
            status: "Superseded" as RequirementStatus,
            superseded_by: "X-003",
          }),
          mkReq({ id: "X-003" }),
        ],
      }),
    ];
    expect(validateStructure(specs).filter((d) => d.code === "CYCLIC_SUPERSEDE")).toEqual([]);
  });

  test("a requirement pointing INTO a cycle it is not part of is not flagged", () => {
    const specs = [
      mkSpec({
        requirements: [
          mkReq({
            id: "X-001",
            status: "Superseded" as RequirementStatus,
            superseded_by: "X-002",
          }),
          mkReq({
            id: "X-002",
            status: "Superseded" as RequirementStatus,
            superseded_by: "X-003",
          }),
          mkReq({
            id: "X-003",
            status: "Superseded" as RequirementStatus,
            superseded_by: "X-002",
          }),
        ],
      }),
    ];
    const out = validateStructure(specs).filter((d) => d.code === "CYCLIC_SUPERSEDE");
    expect(out.map((d) => d.req_id).sort()).toEqual(["X-002", "X-003"]);
  });
});
