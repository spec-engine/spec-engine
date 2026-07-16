// packages/engine/test/relates.test.ts
//
// RED-16: the `relates: [KEY-NNN, KEY-MMM]` field links a requirement to
// other requirements so that when a related requirement CHANGES (is
// superseded), the relation surfaces on `spec check` instead of rotting
// silently. Two seams under test (the Markdown parser unit seam is retired
// with the hard cutover — D2; relation extraction is now exercised end-to-end
// through the JSON reader by the integration blocks below):
//
//   1. Index/storage — relations land in the derived `relations` table,
//      readable via storage.listRelations() (deterministic order), and
//      participate in build_id (cold-rebuild equivalence).
//   2. Check — RELATES_SUPERSEDED + BROKEN_RELATES warning diagnostics
//      located at the source requirement's id line.
//
// Integration runs against the COMMITTED fixtures/relates-fixture/ (migrated
// to JSON in 18-03) with the DB in a tmpdir (mirrors docs-binding.test.ts).
// The fixture's only diagnostics are the planted Relates defects — code tags
// cover both Active requirements so ORPHAN/UNVERIFIED stay quiet.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IndexResult, Storage } from "@spec-engine/shared";
import { collectDiagnostics } from "../src/check/sqlDiagnostics";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "relates-fixture");

// --- Index/storage + check seams ---------------------------------------------

let tmp: string;
let storage: Storage;
let result: IndexResult;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "spec-relates-"));
  storage = openStorage(join(tmp, "index.sqlite"));
  result = await runIndex({ platformDir: FIXTURE, storage });
});

afterAll(() => {
  storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("relations in the derived index (RED-16)", () => {
  test("listRelations returns the fixture's three relations, deterministically ordered", () => {
    // Fixture migrated to JSON in 18-03: the domainJson reader assigns each
    // relation the SOURCE requirement's `"id"` line (REL-001 → 8, REL-003 → 35),
    // not the authored Relates-field line the Markdown parser used.
    expect(storage.listRelations()).toEqual([
      {
        from_id: "REL-001",
        to_id: "REL-003",
        source_file: "spec-engine/REL/SPEC.json",
        line: 8,
      },
      {
        from_id: "REL-003",
        to_id: "REL-002",
        source_file: "spec-engine/REL/SPEC.json",
        line: 35,
      },
      {
        from_id: "REL-003",
        to_id: "REL-999",
        source_file: "spec-engine/REL/SPEC.json",
        line: 35,
      },
    ]);
  });

  test("build_id covers relations: identical rebuild reproduces it byte-for-byte", async () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "spec-relates-2-"));
    const s2 = openStorage(join(tmp2, "index.sqlite"));
    try {
      const r2 = await runIndex({ platformDir: FIXTURE, storage: s2 });
      expect(r2.build_id).toBe(result.build_id);
      expect(s2.listRelations()).toEqual(storage.listRelations());
    } finally {
      s2.close();
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

describe("spec check surfaces relations when the target changed (RED-16)", () => {
  test("RELATES_SUPERSEDED warning: REL-003 relates to superseded REL-002, located at the Relates line", () => {
    const hit = collectDiagnostics(storage).find((d) => d.code === "RELATES_SUPERSEDED");
    expect(hit).toBeDefined();
    expect(hit?.req_id).toBe("REL-003");
    expect(hit?.severity).toBe("warning");
    expect(hit?.source_file).toBe("spec-engine/REL/SPEC.json");
    expect(hit?.line).toBe(35);
    expect(hit?.detail).toContain("REL-002");
    expect(hit?.detail).toContain("REL-003");
  });

  test("BROKEN_RELATES warning: REL-003 relates to nonexistent REL-999", () => {
    const hit = collectDiagnostics(storage).find((d) => d.code === "BROKEN_RELATES");
    expect(hit).toBeDefined();
    expect(hit?.req_id).toBe("REL-003");
    expect(hit?.severity).toBe("warning");
    expect(hit?.line).toBe(35);
    expect(hit?.detail).toContain("REL-999");
  });

  test("the planted Relates defects are the fixture's ONLY diagnostics (all warnings → check exits 0)", () => {
    // T5: the fixture's planted REL-001 self-reference (Relates line 11)
    // now surfaces as SELF_RELATES instead of vanishing silently. Still
    // warnings-only, so check stays exit 0.
    const codes = collectDiagnostics(storage)
      .map((d) => d.code)
      .sort();
    expect(codes).toEqual(["BROKEN_RELATES", "RELATES_SUPERSEDED", "SELF_RELATES"]);
  });
});
