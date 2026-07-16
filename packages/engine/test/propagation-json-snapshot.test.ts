// packages/engine/test/propagation-json-snapshot.test.ts
//
// PROP-01 / PROP-03 byte-stability lock: `spec propagation BILLING-009 --json`
// against the canonical platform-fixture must produce byte-identical output
// across consecutive cold rebuilds, and the row shape is pinned by a
// snapshot so future fixture or state-machine changes surface immediately.
//
// Runs the citty command in-process (mirroring map-json-snapshot.test.ts).
//
// WR-06: each test runs against a CLONED fixture in tmpdir so the canonical
// `fixtures/platform-fixture/` tree is never mutated by the indexer's
// .spec-engine/ writes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { propagationCommand } from "../src/commands/propagation";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let logs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  // WR-06: clone the canonical fixture into a fresh tmpdir per test.
  clone = cloneFixture(FIXTURE);
  logs = [];
  originalLog = console.log;
  originalErr = console.error;
  originalExit = process.exit;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = () => {
    // Silence schema-rebuild stderr chatter; tests assert on stdout.
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
const propagationRun = (propagationCommand as unknown as { run: RunFn }).run;

async function runPropagation(args: Record<string, unknown>): Promise<number> {
  try {
    await propagationRun({ args, rawArgs: [] });
    return 0; // propagation command does not call process.exit on success
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

describe("spec propagation BILLING-009 --json against canonical platform-fixture", () => {
  test("two consecutive invocations produce byte-identical output", async () => {
    // First invocation: DB is missing → runIndex builds it; emits JSON.
    await runPropagation({ reqId: "BILLING-009", platformDir: clone, json: true });
    const outA = logs[0] ?? "";
    logs.length = 0;

    // Cold-state guarantee: re-clone and re-run from scratch.
    rmSync(clone, { recursive: true, force: true });
    clone = cloneFixture(FIXTURE);
    await runPropagation({ reqId: "BILLING-009", platformDir: clone, json: true });
    const outB = logs[0] ?? "";

    expect(outA).toBe(outB);
    expect(outA.length).toBeGreaterThan(2); // not just "[]"
  });

  test("row count equals 3 member repos", async () => {
    await runPropagation({ reqId: "BILLING-009", platformDir: clone, json: true });
    const parsed = JSON.parse(logs[0] ?? "[]");
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(3);
    expect(parsed.map((r: { repo: string }) => r.repo).sort()).toEqual(["admin", "api", "mobile"]);
  });

  test("JSON shape is stable (snapshot of full PropagationRow projection)", async () => {
    await runPropagation({ reqId: "BILLING-009", platformDir: clone, json: true });
    const parsed = JSON.parse(logs[0] ?? "[]") as Array<Record<string, unknown>>;

    // Project to the contract keys (defensive against future field additions):
    // the (repo, state, via_req_id, drifted) projection is the PROP-01 /
    // PROP-03 contract that `spec propagation --json` exposes downstream.
    const shape = parsed.map((r) => ({
      repo: r.repo,
      state: r.state,
      via_req_id: r.via_req_id,
      drifted: r.drifted,
    }));
    expect(shape).toMatchSnapshot();
  });
});
