// @spec CHCK-023 integration
// @spec OWNER-003 integration
// @spec OWNER-004 integration
//
// The base ref is the unmutated clone; each scenario mutates only the
// working tree copy of spec-engine/BILLING/SPEC.json.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Diagnostic } from "@spec-engine/shared";
import { cloneFixture } from "../testing/cloneFixture";
import { git, gitTestEnv } from "../testing/git";
import { entryOf, plantEdit } from "../testing/plant";
import { checkCommand } from "./check";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");
const BILLING_REL = "spec-engine/BILLING/SPEC.json";

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
  approvedBy?: string;
  requireOwnerApproval?: boolean;
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
        ...(opts.approvedBy !== undefined ? { approvedBy: opts.approvedBy } : {}),
        ...(opts.requireOwnerApproval !== undefined
          ? { requireOwnerApproval: opts.requireOwnerApproval }
          : {}),
      },
      rawArgs: [],
    });
  } catch (e) {
    if (e instanceof ExitError) exitCode = e.code;
    else throw e;
  }
  return { logs: logs.slice(), exitCode };
}

function extractBuildId(captured: string[]): string {
  const line = captured.find((l) => l.startsWith("build_id:"));
  expect(line).toBeDefined();
  return (line as string).slice("build_id:".length).trim();
}

function parseDiags(captured: string[]): Diagnostic[] {
  return JSON.parse(captured[0] ?? "[]") as Diagnostic[];
}

function removeReq(id: string): Promise<void> {
  return plantEdit(clone, "BILLING", (dom) => {
    dom.requirements = dom.requirements.filter((r) => r.id !== id);
  });
}
function flipStatus(id: string, status: string): Promise<void> {
  return plantEdit(clone, "BILLING", (dom) => {
    entryOf(dom, id).status = status;
  });
}

function fixtureClean(): boolean {
  const proc = Bun.spawnSync(["git", "status", "--porcelain", "fixtures/platform-fixture/"], {
    cwd: FIXTURE_REPO,
    env: gitTestEnv(),
  });
  return proc.stdout.toString().trim() === "";
}
const FIXTURE_REPO = resolve(import.meta.dir, "..", "..", "..", "..");

describe("governance integration — cold spec check --ci --base", () => {
  test("Scenario 1: removing BILLING-002 (no successor) fires REQUIREMENT_REMOVED + exit 1", async () => {
    await removeReq("BILLING-002");
    const { logs: out, exitCode } = await runCheck({ ci: true, json: true, base: "HEAD" });
    const got = parseDiags(out);
    expect(got.some((d) => d.code === "REQUIREMENT_REMOVED" && d.req_id === "BILLING-002")).toBe(
      true,
    );
    expect(exitCode).toBe(1);
    expect(fixtureClean()).toBe(true);
  });

  test("Scenario 2: removing Superseded BILLING-001 is REPORTED — history is never deleted, its successor edge is no excuse", async () => {
    await removeReq("BILLING-001");
    const { logs: out, exitCode } = await runCheck({ ci: true, json: true, base: "HEAD" });
    const got = parseDiags(out);
    const hit = got.find((d) => d.code === "REQUIREMENT_REMOVED" && d.req_id === "BILLING-001");
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain("never deleted");
    expect(exitCode).toBe(1);
  });

  test("Scenario 3: whole-file deletion surfaces BILLING-009 via git ls-tree", async () => {
    unlinkSync(join(clone, BILLING_REL));
    const { logs: out, exitCode } = await runCheck({ ci: true, json: true, base: "HEAD" });
    const removed = parseDiags(out)
      .filter((d) => d.code === "REQUIREMENT_REMOVED")
      .map((d) => d.req_id);
    // A working-tree-only enumeration would miss it: its file is gone.
    expect(removed).toContain("BILLING-009");
    expect(removed).toContain("BILLING-002");
    expect(removed).toContain("BILLING-007");
    expect(exitCode).toBe(1);
  });

  test("Scenario 4: status flip is warning by default, error under strict, silent when approved", async () => {
    await flipStatus("BILLING-002", "retired");

    // (a) Default: warning, and NOT an error-severity governance row from the flip.
    const def = await runCheck({
      ci: true,
      json: true,
      base: "HEAD",
      approvedBy: "someone-else",
    });
    const defRows = parseDiags(def.logs).filter((d) => d.code === "UNAPPROVED_STATUS_FLIP");
    expect(defRows.some((d) => d.req_id === "BILLING-002" && d.severity === "warning")).toBe(true);
    expect(defRows.some((d) => d.severity === "error")).toBe(false);

    // (b) Strict: escalates to error + exit 1.
    const strict = await runCheck({
      ci: true,
      json: true,
      base: "HEAD",
      approvedBy: "someone-else",
      requireOwnerApproval: true,
    });
    const strictRows = parseDiags(strict.logs).filter((d) => d.code === "UNAPPROVED_STATUS_FLIP");
    expect(strictRows.some((d) => d.req_id === "BILLING-002" && d.severity === "error")).toBe(true);
    expect(strict.exitCode).toBe(1);

    // (c) Approved by the CODEOWNERS owner (@drea) → silent even under strict.
    const approved = await runCheck({
      ci: true,
      json: true,
      base: "HEAD",
      approvedBy: "drea",
      requireOwnerApproval: true,
    });
    const approvedRows = parseDiags(approved.logs).filter(
      (d) => d.code === "UNAPPROVED_STATUS_FLIP" && d.req_id === "BILLING-002",
    );
    expect(approvedRows.length).toBe(0);
  });

  test("an unresolvable --base ref refuses fail-open with exit 2 (not a silent green)", async () => {
    // A removal governance would catch if the base resolved.
    await removeReq("BILLING-002");
    const { exitCode } = await runCheck({
      ci: true,
      json: true,
      base: "no-such-ref-xyz",
    });
    expect(exitCode).toBe(2);
  });

  test("Scenario 5: build_id byte-identical WITH vs WITHOUT --base", async () => {
    // Governance reads run after runIndex computes the hash.
    const without = await runCheck({ ci: true, json: false });
    const hWithout = extractBuildId(without.logs);
    const withBase = await runCheck({ ci: true, json: false, base: "HEAD" });
    const hWith = extractBuildId(withBase.logs);
    expect(hWith).toBe(hWithout);
    expect(hWith).toMatch(/^[0-9a-f]{64}$/);
  });
});
