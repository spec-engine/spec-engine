import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@spec-engine/shared";
import { openStorage } from "../src/storage/sqlite";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-storage-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("openStorage on a fresh path creates the schema and `coverage` is a VIEW (SCHM-06)", () => {
  const path = join(tmp, "x.sqlite");
  const s = openStorage(path);
  s.close();
  const db = new Database(path);
  const row = db.query("SELECT type FROM sqlite_master WHERE name='coverage'").get() as {
    type: string;
  } | null;
  expect(row).not.toBeNull();
  expect(row?.type).toBe("view");
  db.close();
});

test("every required base table exists after open (SCHM-01..04)", () => {
  const path = join(tmp, "x.sqlite");
  const s = openStorage(path);
  s.close();
  const db = new Database(path);
  const rows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
    name: string;
  }>;
  const names = rows.map((r) => r.name);
  for (const expected of [
    "_schema_version",
    "repos",
    "domains",
    "requirements",
    "tags",
    "parse_diagnostics",
  ]) {
    expect(names).toContain(expected);
  }
  db.close();
});

test("`requirements_fts` is registered as a virtual table (SCHM-05)", () => {
  const path = join(tmp, "x.sqlite");
  const s = openStorage(path);
  s.close();
  const db = new Database(path);
  const row = db
    .query("SELECT type, sql FROM sqlite_master WHERE name='requirements_fts'")
    .get() as { type: string; sql: string } | null;
  expect(row).not.toBeNull();
  // FTS5 virtual tables register as type='table' in sqlite_master.
  expect(row?.type).toBe("table");
  expect(row?.sql).toContain("USING fts5");
  db.close();
});

test("FTS triggers exist (Pitfall 8 prevention)", () => {
  const path = join(tmp, "x.sqlite");
  const s = openStorage(path);
  s.close();
  const db = new Database(path);
  const rows = db.query("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{
    name: string;
  }>;
  const names = rows.map((r) => r.name);
  expect(names).toContain("requirements_ai");
  expect(names).toContain("requirements_ad");
  expect(names).toContain("requirements_au");
  db.close();
});

test("Phase 1 read stubs return empty arrays / null without throwing", () => {
  const path = join(tmp, "x.sqlite");
  const s = openStorage(path);
  expect(s.listRepos()).toEqual([]);
  expect(s.listDomains()).toEqual([]);
  expect(s.listRequirements()).toEqual([]);
  expect(s.listTags()).toEqual([]);
  expect(s.listDiagnostics()).toEqual([]);
  expect(s.coverageMatrix()).toEqual([]);
  expect(s.getRepo("nope")).toBeNull();
  expect(s.getDomain("nope")).toBeNull();
  expect(s.getRequirement("nope")).toBeNull();
  expect(s.searchFts("nothing", 5)).toEqual([]);
  expect(s.propagationFor("nope")).toEqual([]);
  expect(s.resolveByFiles(["nope"])).toEqual([]);
  s.close();
});

test("openStorage on an already-initialized path is idempotent", () => {
  const path = join(tmp, "x.sqlite");
  const s1 = openStorage(path);
  s1.close();
  const s2 = openStorage(path);
  s2.close();
  // If we got here without throwing, the second open is a no-op idempotent path.
  const db = new Database(path);
  const row = db.query("SELECT version FROM _schema_version").get() as { version: number };
  // Bound to the live constant so future bumps don't require a test edit.
  expect(row.version).toBe(SCHEMA_VERSION);
  db.close();
});
