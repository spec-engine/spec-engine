import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@spec-engine/shared";
import { openStorage, poisonSchemaVersion } from "../src/storage/sqlite";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-schemaver-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("schema-version mismatch silently rebuilds the DB (SCHM-09, D-12)", () => {
  const path = join(tmp, "x.sqlite");
  // 1) Open fresh, get a working DB at the current SCHEMA_VERSION.
  openStorage(path).close();
  // 2) Poison the on-disk schema version. RED-14: route through the
  //    poisonSchemaVersion helper (the same one the __schema-mismatch-smoke
  //    CI command uses) instead of a duplicate hand-rolled UPDATE — the
  //    helper is the contract under test.
  poisonSchemaVersion(path, 999);
  // 3) Re-open. The engine must silently rebuild.
  openStorage(path).close();
  // 4) Confirm the on-disk version is now back to current SCHEMA_VERSION.
  const db2 = new Database(path);
  const row = db2.query("SELECT version FROM _schema_version").get() as { version: number };
  expect(row.version).toBe(SCHEMA_VERSION);
  // 5) Confirm a known table from DDL is present after the rebuild.
  const repoTbl = db2
    .query("SELECT name FROM sqlite_master WHERE name='repos' AND type='table'")
    .get();
  expect(repoTbl).not.toBeNull();
  db2.close();
});

test("rebuild logs a single stderr note (D-12 stderr contract)", () => {
  const path = join(tmp, "y.sqlite");
  openStorage(path).close();
  // Poison via a subprocess to capture stderr cleanly.
  const driver = `
    import { Database } from "bun:sqlite";
    import { openStorage } from "${import.meta.dir.replace(/\\/g, "/")}/../src/storage/sqlite";
    const db = new Database(${JSON.stringify(path)});
    db.run("UPDATE _schema_version SET version = ?", [42]);
    db.close();
    const s = openStorage(${JSON.stringify(path)});
    s.close();
  `;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", driver],
    stderr: "pipe",
    stdout: "pipe",
  });
  const stderr = new TextDecoder().decode(result.stderr);
  expect(stderr).toContain("schema version");
  expect(stderr).toContain("rebuilding");
});
