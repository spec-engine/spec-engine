import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Diagnostic } from "@spec-engine/shared";
import { cloneFixture } from "../testing/cloneFixture";
import { checkCommand } from "./check";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

let clone: string;
let dbPath: string;
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

beforeEach(() => {
  clone = cloneFixture(FIXTURE);
  // Inside the clone so the --out containment guard allows it.
  dbPath = join(clone, ".spec-engine", "index.sqlite");
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
const checkRun = (checkCommand as unknown as { run: RunFn }).run;

/** Platform-relative, so the `--results` containment guard passes. */
function writeResults(xml: string): string {
  const rel = "results.xml";
  writeFileSync(join(clone, rel), xml);
  return rel;
}

async function runCheck(opts: {
  ci?: boolean;
  json?: boolean;
  results?: string;
}): Promise<{ logs: string[]; exitCode: number }> {
  logs.length = 0;
  errs.length = 0;
  let exitCode = -1;
  try {
    await checkRun({
      args: {
        platformDir: clone,
        out: dbPath,
        ci: opts.ci ?? false,
        json: opts.json ?? false,
        ...(opts.results !== undefined ? { results: opts.results } : {}),
      },
      rawArgs: [],
    });
  } catch (e) {
    if (e instanceof ExitError) exitCode = e.code;
    else throw e;
  }
  return { logs: logs.slice(), exitCode };
}

/** Text mode only: --json suppresses the `build_id:` line. */
function extractBuildId(captured: string[]): string {
  const line = captured.find((l) => l.startsWith("build_id:"));
  expect(line).toBeDefined();
  return (line as string).slice("build_id:".length).trim();
}

describe("--ci --results (integration): exit code + build_id parity", () => {
  test("--ci --results exits 1 with ≥1 UNPROVEN_REQ when an active req is unproven", async () => {
    // A green but unrelated suite proves neither BILLING-009 nor BILLING-007,
    // both active with verifying tags.
    const results = writeResults(
      `<?xml version="1.0"?>\n<testsuite name="unrelated" tests="1">\n  <testcase name="noop" file="api/test/unrelated.test.ts" line="1" />\n</testsuite>\n`,
    );
    const { logs: out, exitCode } = await runCheck({ ci: true, json: true, results });
    expect(exitCode).toBe(1);
    const got = JSON.parse(out[0] ?? "[]") as Diagnostic[];
    expect(got.some((d) => d.code === "UNPROVEN_REQ")).toBe(true);
  });

  test("build_id is byte-identical WITH vs WITHOUT --results across two cold --ci runs", async () => {
    const run1 = await runCheck({ ci: true, json: false });
    const hWithout = extractBuildId(run1.logs);

    const results = writeResults(
      `<?xml version="1.0"?>\n<testsuite name="unrelated" tests="1">\n  <testcase name="noop" file="api/test/unrelated.test.ts" line="1" />\n</testsuite>\n`,
    );
    const run2 = await runCheck({ ci: true, json: false, results });
    const hWith = extractBuildId(run2.logs);

    // Results ingestion happens after runIndex computes the hash.
    expect(hWith).toBe(hWithout);
    expect(hWith).toMatch(/^[0-9a-f]{64}$/);
  });
});
