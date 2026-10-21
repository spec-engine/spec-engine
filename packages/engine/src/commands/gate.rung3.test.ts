// @spec GATE-008

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { cloneFixture } from "../testing/cloneFixture";
import { TestPlatform } from "../testing/platform";
import { specTag } from "../testing/specTag";
import { gateCommand } from "./gate";

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
  try {
    rmSync(clone, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const gateRun = (gateCommand as unknown as { run: RunFn }).run;

async function runGate(args: Record<string, unknown>): Promise<number> {
  try {
    await gateRun({ args, rawArgs: [] });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

function lastLogAsJson<T = Record<string, unknown>>(): T {
  const last = logs.at(-1) ?? "";
  return JSON.parse(last) as T;
}

describe("spec gate rung-3 flow", () => {
  test("R3: BILLING-010 member plant → NOT_FOUND → add to spec → PASS", async () => {
    // The api repo is pinned @2, so once BILLING-010 lands in the spec at
    // any changed_at_version <= 2, gate passes. The tag is appended so the
    // existing BILLING-009 binding survives.
    const memberPath = join(clone, "api", "src", "renew.ts");
    const memberBefore = readFileSync(memberPath, "utf8");
    // The plant assumes the canonical renew.ts ships with the BILLING-009 tag.
    expect(memberBefore).toContain(specTag("BILLING-009").trimEnd());
    appendFileSync(
      memberPath,
      `\n${specTag("BILLING-010")}export function rungThree() {\n  /* PoC */\n}\n`,
    );

    const code1 = await runGate({
      repo: "api",
      reqId: "BILLING-010",
      platformDir: clone,
      json: true,
    });
    expect(code1).toBe(1);
    const out1 = lastLogAsJson<{ reason: string }>();
    const reason1 = out1.reason;

    // A new requirement with no supersession: changed_at_version defaults
    // to 1.
    const minted = await TestPlatform.at(clone)
      .handle("BILLING")
      .req({
        statement: "Rung-3 demonstration requirement added mid-test.",
        why: "Locks the rung-3 narrative.",
        livesIn: ["renew.ts"],
      });
    expect(minted.id).toBe("BILLING-010");

    logs.length = 0;
    errs.length = 0;

    const code2 = await runGate({
      repo: "api",
      reqId: "BILLING-010",
      platformDir: clone,
      json: true,
    });
    expect(code2).toBe(0);
    const out2 = lastLogAsJson<{ reason: string }>();
    const reason2 = out2.reason;

    expect([reason1, reason2]).toEqual(["NOT_FOUND", "PASS"]);
  });
});
