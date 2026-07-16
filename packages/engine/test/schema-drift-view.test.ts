// packages/engine/test/schema-drift-view.test.ts
//
// CHCK-03 lock: after openStorage() on a fresh path, the `drift` SQL VIEW
// MUST exist in sqlite_master as type='view' (NOT type='table' — that would
// indicate accidental materialization, violating Invariant #3).
//
// Also locks the Storage interface stubs added in plan 03-01:
// `listDriftRows()` and `listSemanticDiagnostics()` are callable, return
// `[]` (real queries land in plan 03-02), and don't throw.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSchema, openStorage } from "../src/storage/sqlite";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-drift-view-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("drift VIEW exists in fresh DB (CHCK-03 / Invariant #3)", () => {
  const path = join(tmp, "x.sqlite");
  const s = openStorage(path);
  s.close();
  const schema = inspectSchema(path);
  expect(schema.views).toContain("drift");
  // Coverage VIEW is the existing Phase 1 contract — must remain unchanged.
  expect(schema.views).toContain("coverage");
});

test("drift is NOT a table (defensive against accidental materialization)", () => {
  const path = join(tmp, "x.sqlite");
  const s = openStorage(path);
  s.close();
  const schema = inspectSchema(path);
  expect(schema.tables).not.toContain("drift");
});

test("Storage exposes listDriftRows + listSemanticDiagnostics returning [] (plan 03-01 stubs)", () => {
  const path = join(tmp, "x.sqlite");
  const s = openStorage(path);
  // Plan 03-01 stubs return empty arrays; plan 03-02 swaps in the real
  // prepared SELECTs against the `drift` VIEW + Q1..Q5 semantic queries.
  expect(s.listDriftRows()).toEqual([]);
  expect(s.listSemanticDiagnostics()).toEqual([]);
  s.close();
});
