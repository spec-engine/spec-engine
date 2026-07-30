// packages/engine/test/check-default-removed.test.ts
//
// D3 (2026-07-30): deletion detection runs by DEFAULT in spec check. With no
// --base flag, the working tree is diffed against HEAD whenever git resolves;
// outside git the check stays silent (never-fail-non-git, like spec guard).
// The supersession exemption applies only to entries Active at HEAD — history
// (superseded/deprecated) removal is always reported (the GUARD-011 rule at
// the check layer).
//
// Verifies:
// @spec CHCK-011 integration

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Diagnostic } from "@spec-engine/shared";
import { checkCommand } from "../src/commands/check";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

let platformDir: string;
let logs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

beforeEach(() => {
  platformDir = cloneFixture(FIXTURE);
  logs = [];
  originalLog = console.log;
  originalErr = console.error;
  originalExit = process.exit;
  console.log = (...a: unknown[]) => {
    logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  };
  console.error = () => {};
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new ExitError(code ?? 0);
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  rmSync(platformDir, { recursive: true, force: true });
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const checkRun = (checkCommand as unknown as { run: RunFn }).run;

function git(...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", platformDir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function initRepo(): void {
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed");
}

/** Delete one requirement entry from a fixture domain in the working tree. */
function deleteEntry(key: string, id: string): void {
  const specPath = join(platformDir, "spec-engine", key, "SPEC.json");
  const doc = JSON.parse(readFileSync(specPath, "utf8"));
  doc.requirements = doc.requirements.filter((r: { id: string }) => r.id !== id);
  writeFileSync(specPath, `${JSON.stringify(doc, null, 2)}\n`);
}

async function runCheckJson(): Promise<{ code: number; rows: Diagnostic[] }> {
  let code = 0;
  try {
    await checkRun({ args: { platformDir, json: true, noPrompt: true }, rawArgs: [] });
  } catch (e) {
    if (e instanceof ExitError) code = e.code;
    else throw e;
  }
  const rows = JSON.parse(logs[logs.length - 1] ?? "[]") as Diagnostic[];
  return { code, rows };
}

describe("default deletion detection (D3 / CHCK-011)", () => {
  test("deleting an Active requirement fails a plain spec check — no flag needed", async () => {
    initRepo();
    // AUTH-001 is Active with zero tags: its removal is ONLY visible to the
    // HEAD diff (no DANGLING_TAG noise).
    deleteEntry("AUTH", "AUTH-001");
    const { code, rows } = await runCheckJson();
    expect(code).toBe(1);
    const hit = rows.find((d) => d.code === "REQUIREMENT_REMOVED" && d.req_id === "AUTH-001");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("error");
  });

  test("superseding in the same change exempts the removal", async () => {
    initRepo();
    const specPath = join(platformDir, "spec-engine", "AUTH", "SPEC.json");
    const doc = JSON.parse(readFileSync(specPath, "utf8"));
    // Replace AUTH-001 with a successor that declares supersedes.
    doc.requirements = [
      {
        id: "AUTH-002",
        status: "active",
        statement: "When a session is idle for 30 days, the system shall expire it.",
        why: null,
        supersedes: "AUTH-001",
        supersededBy: null,
        relates: [],
        livesIn: [],
        issues: [],
      },
    ];
    writeFileSync(specPath, `${JSON.stringify(doc, null, 2)}\n`);
    const { rows } = await runCheckJson();
    expect(rows.some((d) => d.code === "REQUIREMENT_REMOVED" && d.req_id === "AUTH-001")).toBe(
      false,
    );
  });

  test("deleting history (a Superseded entry) is reported even though its successor survives", async () => {
    initRepo();
    // BILLING-001 is Superseded by the surviving BILLING-009 — before the
    // history rule, that successor edge silently excused pruning the record.
    deleteEntry("BILLING", "BILLING-001");
    const { code, rows } = await runCheckJson();
    expect(code).toBe(1);
    const hit = rows.find((d) => d.code === "REQUIREMENT_REMOVED" && d.req_id === "BILLING-001");
    expect(hit).toBeDefined();
    expect(hit?.detail).toContain("never deleted");
  });

  test("outside git the default check stays quiet about deletions", async () => {
    // No git init: same deletion, no REQUIREMENT_REMOVED, exit unaffected.
    deleteEntry("AUTH", "AUTH-001");
    const { rows } = await runCheckJson();
    expect(rows.some((d) => d.code === "REQUIREMENT_REMOVED")).toBe(false);
  });
});
