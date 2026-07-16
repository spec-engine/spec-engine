// packages/engine/test/fresh-flag.test.ts
//
// Audit hygiene pass T9 — `--fresh` on the read commands. The read
// commands trust a schema-matching index by design (speed); `gate` and
// `check --ci` rebuild cold by design (correctness). `--fresh` gives the
// read commands an explicit opt-in to the cold path: rm db + WAL/SHM
// siblings before openStorage (the same trio pattern as check --ci), so
// the command's output reflects the platform AS IT IS NOW.
//
// Tag lines are composed via test/fixtures/specTag.ts (dogfood rule).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapCommand } from "../src/commands/map";
import { propagationCommand } from "../src/commands/propagation";
import { queryCommand } from "../src/commands/query";
import { relationsCommand } from "../src/commands/relations";
import { resolveCommand } from "../src/commands/resolve";
import { specTag } from "./fixtures/specTag";

let tmp: string;
let platform: string;
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

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const run = (cmd: unknown): RunFn => (cmd as { run: RunFn }).run;

// D2: JSON is the sole spec format. ORD-001 is the baseline requirement;
// ORD-002 is appended AFTER the first index to probe staleness.
const ORD_001 = {
  id: "ORD-001",
  status: "active",
  statement: "orders reserve inventory",
  why: "w",
  supersedes: null,
  supersededBy: null,
  relates: [],
  livesIn: [],
  issues: [],
};
const ORD_002 = {
  id: "ORD-002",
  status: "active",
  statement: "refunds reverse inventory",
  why: "w",
  supersedes: null,
  supersededBy: null,
  relates: [],
  livesIn: [],
  issues: [],
};

function writeOrdSpec(reqs: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(platform, "spec-engine", "ORD", "SPEC.json"),
    JSON.stringify(
      { key: "ORD", owner: null, specVersion: 1, updated: "2026-06-05", requirements: reqs },
      null,
      2,
    ),
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-fresh-"));
  platform = join(tmp, "platform");
  mkdirSync(join(platform, "spec-engine", "ORD"), { recursive: true });
  writeOrdSpec([ORD_001]);
  mkdirSync(join(platform, "api", "src"), { recursive: true });
  writeFileSync(join(platform, "api", "spec-engine.member.json"), '{ "specs": "spec-engine@1" }\n');
  writeFileSync(join(platform, "api", "src", "a.ts"), `export const a = 1; ${specTag("ORD-001")}`);

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
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as typeof process.exit;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  rmSync(tmp, { recursive: true, force: true });
});

/** Add ORD-002 to the spec AFTER the index exists — the staleness probe. */
function appendOrd002(): void {
  writeOrdSpec([ORD_001, ORD_002]);
}

describe("--fresh forces a cold rebuild on the read commands (T9)", () => {
  test("map without --fresh trusts the stale index; --fresh sees the new requirement", async () => {
    // Build the index (transparent first-run reindex).
    await run(mapCommand)({ args: { platformDir: platform, json: true }, rawArgs: [] });
    logs = [];
    appendOrd002();

    // Stale read: ORD-002 invisible.
    await run(mapCommand)({ args: { platformDir: platform, json: true }, rawArgs: [] });
    expect(logs.join("\n")).not.toContain("ORD-002");
    logs = [];

    // Fresh read: cold rebuild sees it.
    await run(mapCommand)({
      args: { platformDir: platform, json: true, fresh: true },
      rawArgs: [],
    });
    expect(logs.join("\n")).toContain("ORD-002");
  });

  test("query --fresh retrieves text indexed after the warm build", async () => {
    await run(queryCommand)({
      args: { text: "inventory", platformDir: platform, json: true },
      rawArgs: [],
    });
    logs = [];
    appendOrd002();

    await run(queryCommand)({
      args: { text: "refunds", platformDir: platform, json: true },
      rawArgs: [],
    });
    expect(logs.join("\n")).not.toContain("ORD-002");
    logs = [];

    await run(queryCommand)({
      args: { text: "refunds", platformDir: platform, json: true, fresh: true },
      rawArgs: [],
    });
    expect(logs.join("\n")).toContain("ORD-002");
  });

  test("all five read commands register the --fresh flag", () => {
    for (const cmd of [
      mapCommand,
      queryCommand,
      resolveCommand,
      propagationCommand,
      relationsCommand,
    ]) {
      const args = (cmd as unknown as { args: Record<string, unknown> }).args;
      expect(args.fresh).toBeDefined();
    }
  });
});
