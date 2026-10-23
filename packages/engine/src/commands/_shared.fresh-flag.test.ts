// Tag lines are composed via src/testing/specTag.ts so the self-scan never
// indexes them as this repo's tags.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type DomainHandle, TestPlatform } from "../testing/platform";
import { specTag } from "../testing/specTag";
import { mapCommand } from "./map";
import { propagationCommand } from "./propagation";
import { queryCommand } from "./query";
import { relationsCommand } from "./relations";
import { resolveCommand } from "./resolve";

let fx: TestPlatform;
let platform: string;
let ord: DomainHandle;
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

// ORD-001 is the baseline requirement; ORD-002 is appended AFTER the first
// index to probe staleness.
beforeEach(async () => {
  fx = TestPlatform.temp("spec-fresh-");
  platform = fx.dir;
  ord = await fx.domain("ORD");
  await ord.req({ statement: "Orders reserve inventory.", why: "w" });
  await fx.member("api", {
    files: { "src/a.ts": `export const a = 1; ${specTag("ORD-001")}` },
  });

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
  fx.remove();
});

async function appendOrd002(): Promise<void> {
  const minted = await ord.req({ statement: "Refunds reverse inventory.", why: "w" });
  expect(minted.id).toBe("ORD-002");
}

describe("--fresh forces a cold rebuild on the read commands", () => {
  test("map without --fresh trusts the stale index; --fresh sees the new requirement", async () => {
    await run(mapCommand)({ args: { platformDir: platform, json: true }, rawArgs: [] });
    logs = [];
    await appendOrd002();

    await run(mapCommand)({ args: { platformDir: platform, json: true }, rawArgs: [] });
    expect(logs.join("\n")).not.toContain("ORD-002");
    logs = [];

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
    await appendOrd002();

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
