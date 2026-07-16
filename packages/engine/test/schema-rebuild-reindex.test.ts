// packages/engine/test/schema-rebuild-reindex.test.ts
//
// RED-16 regression guard for the D-12 silent-rebuild path. Read commands
// (`map` / `query` / `resolve` / `propagation` / `serve`) capture
// `needsIndex = !existsSync(dbPath)` BEFORE openStorage. When a SCHEMA_VERSION
// bump lands (1→2→3→4→5 so far), every existing on-disk DB takes the
// silent-rebuild branch inside openStorage: the file is wiped and recreated
// EMPTY — but the command observed "file exists" and skips runIndex, so it
// queries the empty DB and emits [] (exit 0) on every invocation until the
// user manually runs `spec index`. Silent wrong output, the worst kind.
//
// The fix: read commands re-index when the DB existed but came back with
// zero repos — an indexed platform ALWAYS has ≥1 repo row (the canonical),
// so `listRepos().length === 0` is unambiguous "this DB holds no index".
//
// The test simulates "user upgraded spec across a schema bump": build a
// valid index, poison _schema_version to an old number, re-run the command.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { mapCommand } from "../src/commands/map";
import { propagationCommand } from "../src/commands/propagation";
import { queryCommand } from "../src/commands/query";
import { resolveCommand } from "../src/commands/resolve";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage, poisonSchemaVersion } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  clone = cloneFixture(FIXTURE);
  // WR-06-adjacent: the committed fixture tree is clean, but a LOCAL
  // checkout may carry a stale gitignored .spec-engine/ from manual runs — and
  // cloneFixture copies it. Remove it so this test owns the DB lifecycle.
  rmSync(join(clone, ".spec-engine"), { recursive: true, force: true });
  logs = [];
  errs = [];
  originalLog = console.log;
  originalErr = console.error;
  originalExit = process.exit;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new ExitError(code ?? 0);
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  rmSync(clone, { recursive: true, force: true });
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const run = (cmd: unknown): RunFn => (cmd as { run: RunFn }).run;

/** Build a valid index, then poison _schema_version — the exact on-disk
 *  state every user's .spec-engine/index.sqlite is in after a SCHEMA_VERSION
 *  bump ships. */
async function indexThenPoison(): Promise<void> {
  const dbPath = join(clone, ".spec-engine", "index.sqlite");
  const s = openStorage(dbPath);
  await runIndex({ platformDir: clone, storage: s });
  s.close();
  poisonSchemaVersion(dbPath, 1);
}

// Self-review: the predicate fix landed identically in FIVE commands
// (map/query/resolve/propagation/serve). One covered command would not
// guard the other four against a bad merge reverting `if (needsIndex)` —
// each in-process-testable command gets its own case. `serve` is excluded
// (long-running Bun.serve loop, no clean in-process harness); its predicate
// is byte-identical to the four covered here.
describe("schema-version bump → silent rebuild → transparent re-index (RED-16)", () => {
  test("map against a DB from an older schema version re-indexes instead of emitting []", async () => {
    await indexThenPoison();
    await run(mapCommand)({ args: { platformDir: clone, json: true }, rawArgs: [] });
    const rows = JSON.parse(logs[0] ?? "[]") as unknown[];
    expect(rows.length).toBe(20); // 5 requirements × 4 repos
  });

  test("query re-indexes instead of emitting []", async () => {
    await indexThenPoison();
    await run(queryCommand)({
      args: { text: "renewal charge", platformDir: clone, json: true },
      rawArgs: [],
    });
    const rows = JSON.parse(logs[0] ?? "[]") as Array<{ req_id: string }>;
    expect(rows[0]?.req_id).toBe("BILLING-009");
  });

  test("resolve re-indexes instead of emitting []", async () => {
    await indexThenPoison();
    await run(resolveCommand)({
      args: { files: "api/src/renew.ts", platformDir: clone, json: true },
      rawArgs: [],
    });
    const rows = JSON.parse(logs[0] ?? "[]") as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toContain("BILLING-009");
  });

  test("propagation re-indexes instead of emitting []", async () => {
    await indexThenPoison();
    await run(propagationCommand)({
      args: { reqId: "BILLING-009", platformDir: clone, json: true },
      rawArgs: [],
    });
    const rows = JSON.parse(logs[0] ?? "[]") as Array<{ repo: string }>;
    expect(rows.map((r) => r.repo)).toEqual(["admin", "api", "mobile"]);
  });
});
