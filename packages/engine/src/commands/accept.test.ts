// packages/engine/src/commands/accept.test.ts
//
// @spec REQ-040 unit
// @spec REQ-041 unit

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type DomainHandle, TestPlatform } from "../testing/platform";
import { acceptCommand } from "./accept";

let fx: TestPlatform;
let billing: DomainHandle;
let logs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const run = (acceptCommand as unknown as { run: RunFn }).run;

beforeEach(async () => {
  fx = TestPlatform.temp("spec-accept-");
  billing = await fx.domain("BILLING");
  logs = [];
  originalLog = console.log;
  originalErr = console.error;
  originalExit = process.exit;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = () => {};
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

function specText(): string {
  return readFileSync(join(fx.dir, "spec-engine", "BILLING", "SPEC.json"), "utf8");
}

async function exitCodeOf(fn: () => Promise<void>): Promise<number | null> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
  return null;
}

describe("spec accept", () => {
  test("promotes a Draft to active and changes no other field", async () => {
    const draft = await billing.req({
      statement: "refunds reverse the original charge",
      why: "revenue",
      livesIn: ["refund.ts"],
      status: "draft",
    });
    const before = (await billing.read()).requirements.find((r) => r.id === draft.id);

    await run({ args: { id: draft.id, platformDir: fx.dir, json: true }, rawArgs: [] });

    expect(JSON.parse(logs[0] ?? "null")).toEqual({
      id: draft.id,
      file: "spec-engine/BILLING/SPEC.json",
    });
    const after = (await billing.read()).requirements.find((r) => r.id === draft.id);
    expect(after).toEqual({ ...before, status: "active" } as typeof after);
  });

  for (const [label, prepare] of [
    ["Active", async () => (await billing.req({ statement: "s", why: "w" })).id],
    [
      "deprecated",
      async () => {
        const { id } = await billing.req({ statement: "s", why: "w", status: "draft" });
        await billing.deprecate(id);
        return id;
      },
    ],
  ] as const) {
    test(`refuses a ${label} entry with exit 2 and writes nothing`, async () => {
      const id = await prepare();
      const before = specText();

      const code = await exitCodeOf(() => run({ args: { id, platformDir: fx.dir }, rawArgs: [] }));

      expect(code).toBe(2);
      expect(specText()).toBe(before);
    });
  }
});
