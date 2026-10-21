// Runs against the committed fixtures/relates-fixture/ with the DB in a
// tmpdir. Code tags cover both Active requirements, so the fixture's only
// diagnostics are its planted relates defects.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IndexResult, Storage } from "@spec-engine/shared";
import { runIndex } from "../indexer/pipeline";
import { openStorage } from "../storage/sqlite";
import { collectDiagnostics } from "./sqlDiagnostics";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "relates-fixture");

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

describe("relations in the derived index", () => {
  test("listRelations returns the fixture's three relations, deterministically ordered", () => {
    // A relation is located at the source requirement's `"id"` line.
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

describe("spec check surfaces relations when the target changed", () => {
  test("RELATES_SUPERSEDED warning: REL-003 relates to superseded REL-002, located at the source id line", () => {
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
    // REL-001's planted self-reference surfaces as SELF_RELATES.
    const codes = collectDiagnostics(storage)
      .map((d) => d.code)
      .sort();
    expect(codes).toEqual(["BROKEN_RELATES", "RELATES_SUPERSEDED", "SELF_RELATES"]);
  });
});
