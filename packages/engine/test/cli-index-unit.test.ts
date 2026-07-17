// packages/engine/test/cli-index-unit.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INDX-003
//
// RED-14 dead-end audit: `spec index` (commands/index.ts) had NO test at
// the citty command layer — its --json mode, the RED-11 not-a-platform
// branch, and the generic "spec index FAILED" exit-1 branch were all
// uncovered (the pipeline beneath it is covered by pipeline.test.ts /
// cold-rebuild.test.ts; CI smoke 6 covers the compiled binary).
//
// Harness mirrors cli-map-unit.test.ts: ExitError class, beforeEach /
// afterEach stubs over console.log + console.error + process.exit, RunFn
// cast over indexCommand.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { indexCommand } from "../src/commands/index";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let tmp: string;
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
  tmp = mkdtempSync(join(tmpdir(), "spec-cli-index-"));
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
  rmSync(tmp, { recursive: true, force: true });
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const indexRun = (indexCommand as unknown as { run: RunFn }).run;

/** Run index in-process. Returns the exit code if the command called
 *  process.exit, or -1 if it returned normally (success path returns
 *  without exiting — exit 0 is implicit). */
async function runIndexCmd(args: Record<string, unknown>): Promise<number> {
  try {
    await indexRun({ args, rawArgs: [] });
    return -1; // returned normally → implicit exit 0
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

describe("spec index (in-process, RED-14)", () => {
  test("--json emits exactly the IndexResult object on stdout (CI-02 contract)", async () => {
    const clone = cloneFixture(FIXTURE);
    try {
      const code = await runIndexCmd({ platformDir: clone, json: true });
      expect(code).toBe(-1);
      expect(logs.length).toBe(1);
      const result = JSON.parse(logs[0] as string) as {
        build_id: string;
        repos: number;
        requirements: number;
      };
      expect(result.build_id).toMatch(/^[0-9a-f]{64}$/);
      expect(result.repos).toBe(4);
      expect(result.requirements).toBe(5);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  test("human mode prints the summary block (sanity pairing for --json)", async () => {
    const clone = cloneFixture(FIXTURE);
    try {
      const code = await runIndexCmd({ platformDir: clone });
      expect(code).toBe(-1);
      const out = logs.join("\n");
      expect(out).toContain("spec index OK");
      expect(out).toMatch(/build_id: {5}[0-9a-f]{64}/);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  test("non-platform dir → friendly RED-11 message + exit 2, no .spec-engine artifact", async () => {
    const code = await runIndexCmd({ platformDir: tmp });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("is not a Spec Engine platform yet");
    expect(existsSync(join(tmp, ".spec-engine"))).toBe(false);
  });

  test("V12: --out outside platformDir → exit 2 'must be inside platformDir' (parity with every other command)", async () => {
    // RED-14 audit finding: index was the ONLY --out-bearing command with
    // neither the platformDir-relative resolution nor the V12 containment
    // guard (check/map/query/propagation/gate/serve all have both).
    const clone = cloneFixture(FIXTURE);
    // Anchor the escape target to the (unique) clone name so a stale file
    // from an earlier run can never satisfy/poison the assertion.
    const evil = `${clone}-evil.sqlite`;
    try {
      const code = await runIndexCmd({ platformDir: clone, out: evil });
      expect(code).toBe(2);
      expect(errs.join("\n")).toMatch(/must be inside platformDir/);
      expect(existsSync(evil)).toBe(false);
    } finally {
      rmSync(clone, { recursive: true, force: true });
      rmSync(evil, { force: true });
    }
  });

  test("V12: relative --out resolves under platformDir, NOT cwd (parity with check.ts WR-01)", async () => {
    const clone = cloneFixture(FIXTURE);
    const cwdGhost = resolve(process.cwd(), "custom");
    try {
      const code = await runIndexCmd({ platformDir: clone, out: "custom/index.sqlite" });
      expect(code).toBe(-1);
      expect(existsSync(join(clone, "custom", "index.sqlite"))).toBe(true);
      // And nothing was minted relative to the test runner's cwd.
      expect(existsSync(join(cwdGhost, "index.sqlite"))).toBe(false);
    } finally {
      rmSync(clone, { recursive: true, force: true });
      rmSync(cwdGhost, { recursive: true, force: true });
    }
  });

  test("genuine indexing crash (malformed member config) → 'spec index FAILED' + exit 1", async () => {
    // A real platform whose sibling carries a Zod-invalid spec-engine.member.json:
    // assertSpecPlatform passes, runIndex throws — the generic FAILED
    // branch must keep its exit-1 contract (distinct from the exit-2
    // not-a-platform path).
    mkdirSync(join(tmp, "spec-engine"), { recursive: true });
    mkdirSync(join(tmp, "member"), { recursive: true });
    writeFileSync(
      join(tmp, "member", "spec-engine.member.json"),
      JSON.stringify({ specs: "bogus" }),
    );

    const code = await runIndexCmd({ platformDir: tmp });
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("spec index FAILED:");
  });
});
