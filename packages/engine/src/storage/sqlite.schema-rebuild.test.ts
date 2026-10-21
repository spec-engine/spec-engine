// Read commands decide `needsIndex` from file existence before openStorage,
// but a schema-version mismatch makes openStorage recreate the file empty. An
// indexed platform always has at least one repo row, so zero repos is what
// tells the command to re-index instead of emitting [].

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { mapCommand } from "../commands/map";
import { propagationCommand } from "../commands/propagation";
import { queryCommand } from "../commands/query";
import { resolveCommand } from "../commands/resolve";
import { runIndex } from "../indexer/pipeline";
import { cloneFixture } from "../testing/cloneFixture";
import { openStorage, poisonSchemaVersion } from "./sqlite";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

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
  // A local checkout may carry a stale gitignored .spec-engine/ that
  // cloneFixture copies; this test must own the DB lifecycle.
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

/** The on-disk state every user's index is in after a SCHEMA_VERSION bump ships. */
async function indexThenPoison(): Promise<void> {
  const dbPath = join(clone, ".spec-engine", "index.sqlite");
  const s = openStorage(dbPath);
  await runIndex({ platformDir: clone, storage: s });
  s.close();
  poisonSchemaVersion(dbPath, 1);
}

// Each command carries its own copy of the predicate, so each gets a case.
// `serve` is not covered: its Bun.serve loop has no clean in-process harness.
describe("schema-version bump → silent rebuild → transparent re-index", () => {
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
