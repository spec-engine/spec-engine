// packages/engine/src/commands/get.test.ts
//
// The command over the canonical fixture, driven in-process: found, unknown,
// malformed, and byte-stable JSON.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { cloneFixture } from "../testing/cloneFixture";
import { getCommand } from "./get";

const FIXTURE = join(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const run = (getCommand as unknown as { run: RunFn }).run;

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

let platformDir: string;
let logs: string[];
let errs: string[];
const origLog = console.log;
const origErr = console.error;
const origExit = process.exit;

beforeAll(() => {
  platformDir = cloneFixture(FIXTURE);
});
afterAll(() => {
  rmSync(platformDir, { recursive: true, force: true });
});
beforeEach(() => {
  logs = [];
  errs = [];
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  };
  process.exit = ((code: number) => {
    throw new ExitError(code);
  }) as typeof process.exit;
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  process.exit = origExit;
});

async function exitCode(fn: () => Promise<void>): Promise<number> {
  try {
    await fn();
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

// @spec MAP-003 unit
describe("spec get", () => {
  test("a known id prints its record; --json is one object, byte-stable across runs", async () => {
    await run({
      args: { reqId: "BILLING-009", platformDir, json: true, noPrompt: true },
      rawArgs: [],
    });
    const first = logs.join("\n");
    const row = JSON.parse(first) as { id: string; status: string; text: string };
    expect(row.id).toBe("BILLING-009");
    expect(row.status).toBe("Active");
    expect(row.text.length).toBeGreaterThan(0);

    logs = [];
    await run({
      args: { reqId: "BILLING-009", platformDir, json: true, noPrompt: true },
      rawArgs: [],
    });
    expect(logs.join("\n")).toBe(first);
  });

  test("text mode renders the header and the row", async () => {
    await run({ args: { reqId: "BILLING-009", platformDir, noPrompt: true }, rawArgs: [] });
    const out = logs.join("\n");
    expect(out).toContain("ID");
    expect(out).toContain("STATUS");
    expect(out).toContain("BILLING-009");
    expect(out).toContain("Active");
  });

  test("an unknown id is [] on stdout, guidance on stderr, exit 0", async () => {
    const code = await exitCode(() =>
      run({ args: { reqId: "BILLING-999", platformDir, json: true, noPrompt: true }, rawArgs: [] }),
    );
    expect(code).toBe(0);
    expect(logs).toEqual(["[]"]);
    expect(errs.join("\n")).toContain("BILLING-999");
  });

  test("a malformed id is exit 2", async () => {
    const code = await exitCode(() =>
      run({ args: { reqId: "not-an-id", platformDir, noPrompt: true }, rawArgs: [] }),
    );
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("KEY-NNN");
  });
});
