import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@spec-engine/shared";
import { openStorage, poisonSchemaVersion } from "./sqlite";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-schemaver-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("schema-version mismatch silently rebuilds the DB", () => {
  const path = join(tmp, "x.sqlite");
  openStorage(path).close();
  // The same helper the __schema-mismatch-smoke CI command uses, not a
  // hand-rolled UPDATE: the helper is part of the contract under test.
  poisonSchemaVersion(path, 999);
  openStorage(path).close();
  const db2 = new Database(path);
  const row = db2.query("SELECT version FROM _schema_version").get() as { version: number };
  expect(row.version).toBe(SCHEMA_VERSION);
  const repoTbl = db2
    .query("SELECT name FROM sqlite_master WHERE name='repos' AND type='table'")
    .get();
  expect(repoTbl).not.toBeNull();
  db2.close();
});

test("rebuild logs a stderr note", () => {
  const path = join(tmp, "y.sqlite");
  openStorage(path).close();
  // Poison via a subprocess to capture stderr cleanly.
  const driver = `
    import { Database } from "bun:sqlite";
    import { openStorage } from "${import.meta.dir.replace(/\\/g, "/")}/sqlite";
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
