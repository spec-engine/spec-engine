// @spec GUARD-030 unit

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { cloneFixture } from "../testing/cloneFixture";
import { CI_BASE_WARNING, checkCommand } from "./check";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

let platformDir: string;
let errs: string[];
const originalLog = console.log;
const originalErr = console.error;
const originalExit = process.exit;

beforeEach(() => {
  platformDir = cloneFixture(FIXTURE);
  errs = [];
  console.log = () => {};
  console.error = (...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  };
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

function commitAll(): void {
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed");
}

async function warned(args: Record<string, unknown>): Promise<boolean> {
  try {
    await checkRun({ args: { platformDir, json: true, noPrompt: true, ...args }, rawArgs: [] });
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
  }
  return errs.includes(CI_BASE_WARNING);
}

describe("check --ci without --base", () => {
  test("warns when the tracked tree equals HEAD", async () => {
    commitAll();
    expect(await warned({ ci: true })).toBe(true);
  });

  test("stays quiet when a tracked file differs from HEAD", async () => {
    commitAll();
    appendFileSync(join(platformDir, "platform-map.json"), "\n");
    expect(await warned({ ci: true })).toBe(false);
  });

  test("stays quiet when --base is given", async () => {
    commitAll();
    expect(await warned({ ci: true, base: "HEAD" })).toBe(false);
  });

  test("stays quiet outside git", async () => {
    expect(await warned({ ci: true })).toBe(false);
  });

  test("stays quiet without --ci", async () => {
    commitAll();
    expect(await warned({})).toBe(false);
  });
});
