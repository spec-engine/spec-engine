import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSchema, openStorage } from "./sqlite";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-drift-view-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("drift and coverage VIEWs exist in fresh DB", () => {
  const path = join(tmp, "x.sqlite");
  const s = openStorage(path);
  s.close();
  const schema = inspectSchema(path);
  expect(schema.views).toContain("drift");
  expect(schema.views).toContain("coverage");
});

test("drift is NOT a table (defensive against accidental materialization)", () => {
  const path = join(tmp, "x.sqlite");
  const s = openStorage(path);
  s.close();
  const schema = inspectSchema(path);
  expect(schema.tables).not.toContain("drift");
});

test("listDriftRows + listSemanticDiagnostics return [] on an empty DB", () => {
  const path = join(tmp, "x.sqlite");
  const s = openStorage(path);
  expect(s.listDriftRows()).toEqual([]);
  expect(s.listSemanticDiagnostics()).toEqual([]);
  s.close();
});
