// packages/engine/test/rung-ladder.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// Per-rung verifying tags live on each rung's block below (INIT-010/011/012).
//
// RED-14: one acceptance test per adoption-ladder rung (README § Adoption),
// each driven through the real CLI command layer against the shipped
// fixtures. Rungs 1 and 3 have dedicated deep suites already
// (single-repo.test.ts / discover.test.ts for rung 1; gate-rung3.test.ts +
// cli-gate-unit.test.ts for rung 3) — this file is the ladder-level lock
// that all three rungs stay demonstrable end-to-end, and it closes the
// rung-2 gap: nothing previously proved that `spec check --ci` GATES a
// single repo (exits 1 on the planted mess, exits 0 once tags satisfy the
// spec).
//
//   Rung 1 — "Stop re-explaining": one repo, specs inline, zero config.
//            `spec map` renders coverage with the repo's own basename
//            as the lone member column.
//   Rung 2 — "Prove it": @spec tags bind tests to requirements and
//            `spec check --ci` gates. Red on the planted ORPHAN_REQ /
//            UNVERIFIED_REQ; green once every Active requirement is
//            implemented AND verified.
//   Rung 3 — "Coordinate it": dedicated spec-engine repo + version-pinned
//            members; `spec gate` passes an approved requirement and
//            blocks a superseded one.
//
// WR-06 discipline: every test clones its fixture; the canonical trees
// under fixtures/ are NEVER mutated (the planted mess stays planted).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkCommand } from "../src/commands/check";
import { gateCommand } from "../src/commands/gate";
import { mapCommand } from "../src/commands/map";
import { cloneFixture } from "./fixtures/cloneFixture";
import { specTag } from "./fixtures/specTag";

const SINGLE_REPO = resolve(import.meta.dir, "..", "..", "..", "fixtures", "single-repo-fixture");
const PLATFORM = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;
const clones: string[] = [];

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
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
  for (const c of clones.splice(0)) rmSync(c, { recursive: true, force: true });
});

function clone(fixture: string): string {
  const c = cloneFixture(fixture);
  clones.push(c);
  return c;
}

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;

async function run(command: unknown, args: Record<string, unknown>): Promise<number> {
  try {
    await (command as { run: RunFn }).run({ args, rawArgs: [] });
    return -1; // returned normally → implicit exit 0
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

describe("adoption ladder (RED-14)", () => {
  // ----- Rung 1: one repo, specs inline, zero ceremony ----------------------
  // @spec INIT-010 e2e
  test("rung 1: spec map self-consumes the lone repo — basename column, no config", async () => {
    const repo = clone(SINGLE_REPO);
    const code = await run(mapCommand, { platformDir: repo });
    expect(code).toBe(-1);
    const out = logs.join("\n");
    // The coverage column is the repo's own basename (self-member).
    const base = repo.split("/").at(-1) as string;
    expect(out).toContain(base);
    expect(out).toContain("ORDERS-001");
    expect(out).toContain("src+test");
  });

  // ----- Rung 2: tags bind tests; check --ci gates ---------------------------
  // @spec INIT-011 e2e
  test("rung 2 red: planted single repo FAILS spec check --ci (ORPHAN_REQ + UNVERIFIED_REQ)", async () => {
    const repo = clone(SINGLE_REPO);
    const code = await run(checkCommand, { platformDir: repo, ci: true });
    expect(code).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("ORPHAN_REQ");
    expect(out).toContain("ORDERS-003");
    expect(out).toContain("UNVERIFIED_REQ");
    expect(out).toContain("ORDERS-002");
    // Single-repo mode: nothing to pin against, no sibling without config.
    expect(out).not.toContain("DRIFT");
    expect(out).not.toContain("NO_SPEC_CONFIG");
  });

  test("rung 2 green: once every Active req is implemented AND verified, check --ci exits 0", async () => {
    const repo = clone(SINGLE_REPO);
    // Satisfy the spec IN THE CLONE (the canonical planted mess is never
    // touched): implement ORDERS-003, verify ORDERS-002 + ORDERS-003.
    appendFileSync(
      join(repo, "src", "orders.ts"),
      `\n${specTag("ORDERS-003")}export function releaseReservation(): void {}\n`,
    );
    appendFileSync(
      join(repo, "test", "orders.test.ts"),
      `\n${specTag("ORDERS-002", "unit")}export function testConfirmOrderEmitsEvent(): boolean {\n  return true;\n}\n` +
        `\n${specTag("ORDERS-003", "unit")}export function testCancelReleasesInventory(): boolean {\n  return true;\n}\n`,
    );
    const code = await run(checkCommand, { platformDir: repo, ci: true });
    expect(code).toBe(0);
  });

  // ----- Rung 3: dedicated spec repo + approval gate -------------------------
  // @spec INIT-012 e2e
  test("rung 3: spec gate passes an approved requirement (api BILLING-009)", async () => {
    const platform = clone(PLATFORM);
    const code = await run(gateCommand, {
      repo: "api",
      reqId: "BILLING-009",
      platformDir: platform,
      json: true,
    });
    expect(code).toBe(0);
    const outcome = JSON.parse(logs.at(-1) ?? "{}") as { pass: boolean; reason: string };
    expect(outcome.pass).toBe(true);
    expect(outcome.reason).toBe("PASS");
  });

  test("rung 3: spec gate blocks a member still on the superseded requirement (mobile BILLING-001)", async () => {
    const platform = clone(PLATFORM);
    const code = await run(gateCommand, {
      repo: "mobile",
      reqId: "BILLING-001",
      platformDir: platform,
      json: true,
    });
    expect(code).toBe(1);
    const outcome = JSON.parse(logs.at(-1) ?? "{}") as { reason: string; detail: string };
    expect(outcome.reason).toBe("SUPERSEDED");
    expect(outcome.detail).toContain("BILLING-009");
  });
});
