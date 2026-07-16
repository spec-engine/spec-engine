// packages/engine/test/check-governance-int.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec GUARD-010 integration
// @spec OWNER-001 integration
// @spec GOV-03 integration
//
// GOV-01/02/03 at the INTEGRATION layer: one in-process `spec check --ci --base
// HEAD` over a git-init'd clone proves the governance teeth compose correctly
// through the real command (git transport via git show/ls-tree, CODEOWNERS
// resolution, cold build, exit codes, build_id parity). The base ref is the
// UNMUTATED clone (committed baseline); each scenario mutates only the WORKING
// TREE copy of spec-engine/BILLING/SPEC.json — the canonical fixture is never
// touched (rmSync in afterEach; a git-status assertion belt-and-suspenders it).
//
//   - Scenario 1: remove BILLING-002 (no successor) → REQUIREMENT_REMOVED + exit 1
//   - Scenario 2: remove BILLING-001 (supersededBy BILLING-009 survives) → exempt
//   - Scenario 3: delete the whole domain file → git ls-tree still surfaces
//     BILLING-009 (the id a working-tree-only scan would MISS)
//   - Scenario 4: flip BILLING-002 → retired: warning by default, error under
//     --require-owner-approval, silent when --approved-by names the owner
//   - Scenario 5: build_id byte-identical WITH vs WITHOUT --base (GATE-04)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Diagnostic } from "@spec-engine/shared";
import { checkCommand } from "../src/commands/check";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");
const BILLING_REL = "spec-engine/BILLING/SPEC.json";

// Deterministic git identity so commits succeed on a bare CI runner.
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
  // The base ref is the UNMUTATED clone. git init + commit BEFORE any mutation.
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

/** Invoke checkCommand.run against the clone with the supplied governance flags. */
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

// ---- working-tree mutators (clone only; never the canonical fixture) --------

type RawReq = { id: string; status: string; [k: string]: unknown };
type RawDomain = { requirements: RawReq[]; [k: string]: unknown };

function readBilling(): RawDomain {
  return JSON.parse(readFileSync(join(clone, BILLING_REL), "utf8")) as RawDomain;
}
function writeBilling(dom: RawDomain): void {
  writeFileSync(join(clone, BILLING_REL), `${JSON.stringify(dom, null, 2)}\n`);
}
function removeReq(id: string): void {
  const dom = readBilling();
  dom.requirements = dom.requirements.filter((r) => r.id !== id);
  writeBilling(dom);
}
function flipStatus(id: string, status: string): void {
  const dom = readBilling();
  for (const r of dom.requirements) if (r.id === id) r.status = status;
  writeBilling(dom);
}

/** Belt-and-suspenders: the canonical fixture is never git-dirty after a run. */
function fixtureClean(): boolean {
  const proc = Bun.spawnSync(["git", "status", "--porcelain", "fixtures/platform-fixture/"], {
    cwd: FIXTURE_REPO,
  });
  return proc.stdout.toString().trim() === "";
}
const FIXTURE_REPO = resolve(import.meta.dir, "..", "..", "..");

describe("governance integration (GOV-01/02/03) — cold spec check --ci --base", () => {
  test("Scenario 1: removing BILLING-002 (no successor) fires REQUIREMENT_REMOVED + exit 1", async () => {
    removeReq("BILLING-002");
    const { logs: out, exitCode } = await runCheck({ ci: true, json: true, base: "HEAD" });
    const got = parseDiags(out);
    expect(got.some((d) => d.code === "REQUIREMENT_REMOVED" && d.req_id === "BILLING-002")).toBe(
      true,
    );
    expect(exitCode).toBe(1);
    expect(fixtureClean()).toBe(true);
  });

  test("Scenario 2: removing BILLING-001 is exempt (supersededBy BILLING-009 survives)", async () => {
    removeReq("BILLING-001");
    const { logs: out } = await runCheck({ ci: true, json: true, base: "HEAD" });
    const got = parseDiags(out);
    expect(got.some((d) => d.code === "REQUIREMENT_REMOVED" && d.req_id === "BILLING-001")).toBe(
      false,
    );
  });

  test("Scenario 3: whole-file deletion surfaces BILLING-009 via git ls-tree", async () => {
    unlinkSync(join(clone, BILLING_REL));
    const { logs: out, exitCode } = await runCheck({ ci: true, json: true, base: "HEAD" });
    const removed = parseDiags(out)
      .filter((d) => d.code === "REQUIREMENT_REMOVED")
      .map((d) => d.req_id);
    // The id a working-tree-only enumeration would MISS (its file is gone):
    expect(removed).toContain("BILLING-009");
    // And the plainly-removed active reqs:
    expect(removed).toContain("BILLING-002");
    expect(removed).toContain("BILLING-007");
    expect(exitCode).toBe(1);
  });

  test("Scenario 4: status flip is warning by default, error under strict, silent when approved", async () => {
    flipStatus("BILLING-002", "retired");

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

  test("CR-01: an unresolvable --base ref refuses fail-open with exit 2 (not a silent green)", async () => {
    // Remove a requirement so governance WOULD fire if the base resolved — the
    // point is that an unresolvable ref must NOT silently no-op to green.
    removeReq("BILLING-002");
    const { exitCode } = await runCheck({
      ci: true,
      json: true,
      base: "no-such-ref-xyz",
    });
    // Exit 2 = usage error (distinct from exit 1 = diagnostics), NOT 0/1.
    expect(exitCode).toBe(2);
  });

  test("Scenario 5 (GATE-04): build_id byte-identical WITH vs WITHOUT --base", async () => {
    // No mutation → base == change → governance silent. The point is the hash is
    // unmoved by --base (governance reads sit BELOW runIndex — temporal isolation).
    const without = await runCheck({ ci: true, json: false });
    const hWithout = extractBuildId(without.logs);
    const withBase = await runCheck({ ci: true, json: false, base: "HEAD" });
    const hWith = extractBuildId(withBase.logs);
    expect(hWith).toBe(hWithout);
    expect(hWith).toMatch(/^[0-9a-f]{64}$/);
  });
});
