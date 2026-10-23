import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RULE_ZERO } from "@spec-engine/shared";
import { TestPlatform } from "../testing/platform";
import { lintCommand } from "./lint";

const BAD = "The endpoint previously answered 404.";
const ALSO_BAD = "We use pg-boss for jobs.";

let fx: TestPlatform;
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
const run = (lintCommand as unknown as { run: RunFn }).run;

beforeEach(async () => {
  fx = TestPlatform.temp("spec-lint-");
  fx.checkConfig({
    severity: [],
    statementRules: { severity: { "no-history": "warning", "no-tool-statement": "warning" } },
  });
  const billing = await fx.domain("BILLING");
  await billing.req({ statement: BAD });
  await billing.req({ statement: "The endpoint answers 404 for an unknown id." });
  await billing.req({ statement: ALSO_BAD, status: "draft" });
  await (await fx.domain("AUTH")).req({ statement: ALSO_BAD });
  fx.checkConfig({ severity: [] });
  logs = [];
  errs = [];
  originalLog = console.log;
  originalErr = console.error;
  originalExit = process.exit;
  console.log = (...a: unknown[]) => {
    logs.push(a.join(" "));
  };
  console.error = (...a: unknown[]) => {
    errs.push(a.join(" "));
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

async function lint(args: Record<string, unknown>): Promise<number> {
  try {
    await run({ args, rawArgs: [] });
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
  return -1;
}

const HISTORY =
  'BILLING-001 no-history: "previously" — a statement says what holds now, not how it got there';
const TOOL_AUTH =
  'AUTH-001 no-tool-statement: "We use" — naming the tool in use is a decision record, not a requirement';
const TOOL_DRAFT =
  'BILLING-003 no-tool-statement: "We use" — naming the tool in use is a decision record, not a requirement';

// @spec CHCK-067 unit
describe("spec lint scopes", () => {
  test("the platform: every finding, rule 0 on stderr, exit 1", async () => {
    expect(await lint({ target: fx.dir })).toBe(1);
    expect(logs).toEqual([TOOL_AUTH, HISTORY]);
    expect(errs).toEqual([RULE_ZERO]);
  });

  test("one domain", async () => {
    expect(await lint({ target: "BILLING", platformDir: fx.dir })).toBe(1);
    expect(logs).toEqual([HISTORY]);
  });

  test("one requirement, clean, exits 0 and prints nothing", async () => {
    expect(await lint({ target: "BILLING-002", platformDir: fx.dir })).toBe(0);
    expect(logs).toEqual([]);
    expect(errs).toEqual([]);
  });

  test("an unknown domain or id exits 2", async () => {
    expect(await lint({ target: "NOPE", platformDir: fx.dir })).toBe(2);
    expect(await lint({ target: "BILLING-099", platformDir: fx.dir })).toBe(2);
  });
});

// @spec CHCK-051 unit
test("--all judges Draft requirements too", async () => {
  expect(await lint({ target: "BILLING", platformDir: fx.dir, all: true })).toBe(1);
  expect(logs).toEqual([HISTORY, TOOL_DRAFT]);
});

// @spec CHCK-058 unit
test("--json prints the findings as a sorted array", async () => {
  expect(await lint({ target: fx.dir, json: true })).toBe(1);
  const rows = JSON.parse(logs.join("\n"));
  expect(rows.map((r: { req_id: string; rule: string }) => [r.req_id, r.rule])).toEqual([
    ["AUTH-001", "no-tool-statement"],
    ["BILLING-001", "no-history"],
  ]);
  expect(Object.keys(rows[0])).toEqual([
    "req_id",
    "rule",
    "detail",
    "reason",
    "source_file",
    "line",
  ]);
  expect(errs).toEqual([]);
});
