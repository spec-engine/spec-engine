// packages/engine/src/commands/list.test.ts
//
// The command over the canonical fixture, driven in-process: full listing,
// the two filters, the bad-status refusal, and byte-stable JSON.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { cloneFixture } from "../testing/cloneFixture";
import { listCommand } from "./list";

const FIXTURE = join(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const run = (listCommand as unknown as { run: RunFn }).run;

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

function rows(): Array<{ id: string; key: string; seq: number; status: string }> {
  return JSON.parse(logs.join("\n"));
}

// @spec MAP-004 unit
describe("spec list", () => {
  test("--json lists every record in (key, seq) order and is byte-stable", async () => {
    await run({ args: { platformDir, json: true, noPrompt: true }, rawArgs: [] });
    const first = logs.join("\n");
    const all = rows();
    expect(all.length).toBeGreaterThan(1);
    const order = all.map((r) => `${r.key}-${String(r.seq).padStart(6, "0")}`);
    expect(order).toEqual([...order].sort());

    logs = [];
    await run({ args: { platformDir, json: true, noPrompt: true }, rawArgs: [] });
    expect(logs.join("\n")).toBe(first);
  });

  test("--status superseded includes BILLING-001, which spec query never returns", async () => {
    await run({
      args: { platformDir, status: "superseded", json: true, noPrompt: true },
      rawArgs: [],
    });
    const ids = rows().map((r) => r.id);
    expect(ids).toContain("BILLING-001");
    expect(rows().every((r) => r.status === "Superseded")).toBe(true);
  });

  test("--domain narrows to one key, case-insensitively", async () => {
    await run({
      args: { platformDir, domain: "billing", json: true, noPrompt: true },
      rawArgs: [],
    });
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().every((r) => r.key === "BILLING")).toBe(true);
  });

  test("text mode renders a header and one line per record", async () => {
    await run({ args: { platformDir, domain: "BILLING", noPrompt: true }, rawArgs: [] });
    const lines = logs.join("\n").split("\n");
    expect(lines[0]).toContain("ID");
    expect(lines[0]).toContain("TEXT");
    expect(lines.length).toBeGreaterThan(2);
  });

  test("a --status outside the four is exit 2 naming the choices", async () => {
    const code = await exitCode(() =>
      run({ args: { platformDir, status: "retired", json: true, noPrompt: true }, rawArgs: [] }),
    );
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("active|draft|superseded|deprecated");
  });
});
