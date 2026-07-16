// packages/engine/test/check-propagation-int.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec PROOF-007 integration
//
// PROP-01 end-to-end over BILLING-007 (the cart-vs-invoice scenario): a CHANGED
// active rule with two verifying sites — api/test/tax.test.ts and
// admin/test/reports.int.test.ts — where one bound site re-proved green and the
// other did not fires ONE error PARTIAL_PROPAGATION (exit 1) WITHOUT
// double-diagnosing UNPROVEN_REQ (one verifying tag passed). An all-pass results
// file is silent; the same partial results WITHOUT --base is inert (PROP-01
// needs the base diff to know the rule changed).
//
// The base ref is the UNMUTATED clone; each test changes only the WORKING TREE
// copy of BILLING-007's statement so `changedRules` fires. The canonical fixture
// is never touched (rmSync in afterEach + git-status assertion).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Diagnostic } from "@spec-engine/shared";
import { checkCommand } from "../src/commands/check";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");
const FIXTURE_REPO = resolve(import.meta.dir, "..", "..", "..");
const BILLING_REL = "spec-engine/BILLING/SPEC.json";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "spec-check Test",
  GIT_AUTHOR_EMAIL: "test@spec.local",
  GIT_COMMITTER_NAME: "spec-check Test",
  GIT_COMMITTER_EMAIL: "test@spec.local",
};

function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

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
  dbPath = join(clone, ".spec-engine", "index.sqlite");
  git(clone, "init", "-q");
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "baseline");
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

async function runCheck(opts: {
  ci?: boolean;
  json?: boolean;
  base?: string;
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
        ...(opts.base !== undefined ? { base: opts.base } : {}),
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

/** Write `xml` into the clone; return the platformDir-relative path (V12 guard). */
function writeResults(xml: string): string {
  const rel = "results.xml";
  writeFileSync(join(clone, rel), xml);
  return rel;
}

function parseDiags(captured: string[]): Diagnostic[] {
  return JSON.parse(captured[0] ?? "[]") as Diagnostic[];
}

type RawReq = { id: string; statement: string; [k: string]: unknown };
type RawDomain = { requirements: RawReq[]; [k: string]: unknown };

/** Change BILLING-007's statement in the working tree so `changedRules` fires. */
function changeBilling007Statement(): void {
  const dom = JSON.parse(readFileSync(join(clone, BILLING_REL), "utf8")) as RawDomain;
  for (const r of dom.requirements) {
    if (r.id === "BILLING-007")
      r.statement = `${r.statement} Also apply rounding rules per region.`;
  }
  writeFileSync(join(clone, BILLING_REL), `${JSON.stringify(dom, null, 2)}\n`);
}

/** JUnit with the two BILLING-007 verifying sites at the given pass/fail states. */
function junit(taxPass: boolean, reportsPass: boolean): string {
  const tc = (file: string, pass: boolean) =>
    pass
      ? `  <testcase name="t" file="${file}" line="1" />`
      : `  <testcase name="t" file="${file}" line="1"><failure message="boom"/></testcase>`;
  return `<?xml version="1.0"?>\n<testsuite name="prop" tests="2">\n${tc("api/test/tax.test.ts", taxPass)}\n${tc("admin/test/reports.int.test.ts", reportsPass)}\n</testsuite>\n`;
}

function fixtureClean(): boolean {
  const proc = Bun.spawnSync(["git", "status", "--porcelain", "fixtures/platform-fixture/"], {
    cwd: FIXTURE_REPO,
  });
  return proc.stdout.toString().trim() === "";
}

describe("propagation integration (PROP-01) — changed BILLING-007, partial re-prove", () => {
  test("Scenario 1: one site passes, one fails → PARTIAL_PROPAGATION + exit 1, no UNPROVEN_REQ", async () => {
    changeBilling007Statement();
    const results = writeResults(junit(/* tax */ true, /* reports */ false));
    const { logs: out, exitCode } = await runCheck({ ci: true, json: true, base: "HEAD", results });
    const got = parseDiags(out);
    expect(got.some((d) => d.code === "PARTIAL_PROPAGATION" && d.req_id === "BILLING-007")).toBe(
      true,
    );
    // No double-diagnosis: one verifying tag passed, so BILLING-007 is PROVEN.
    expect(got.some((d) => d.code === "UNPROVEN_REQ" && d.req_id === "BILLING-007")).toBe(false);
    expect(exitCode).toBe(1);
    expect(fixtureClean()).toBe(true);
  });

  test("Scenario 2: both sites pass → no PARTIAL_PROPAGATION (fully propagated)", async () => {
    changeBilling007Statement();
    const results = writeResults(junit(true, true));
    const { logs: out } = await runCheck({ ci: true, json: true, base: "HEAD", results });
    const got = parseDiags(out);
    expect(got.some((d) => d.code === "PARTIAL_PROPAGATION" && d.req_id === "BILLING-007")).toBe(
      false,
    );
  });

  test("Scenario 3: same partial results WITHOUT --base → inert (PROP-01 needs the base diff)", async () => {
    changeBilling007Statement();
    const results = writeResults(junit(true, false));
    const { logs: out } = await runCheck({ ci: true, json: true, results });
    const got = parseDiags(out);
    expect(got.some((d) => d.code === "PARTIAL_PROPAGATION")).toBe(false);
  });
});
