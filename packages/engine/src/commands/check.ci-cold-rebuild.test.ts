// @spec CHCK-014
//
// The cold reset is an in-place wipe, never an unlink: an unlinked file
// leaves a long-lived `spec serve` reader on the ghost inode, serving stale
// data. poisonRepoRow plants a `repos` row no real scan could produce.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { runIndex } from "../indexer/pipeline";
import { listRepoNamesFromDb, openStorage, poisonRepoRow } from "../storage/sqlite";
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

async function runCheckWithFlags(ci: boolean): Promise<number> {
  let exitCode = -1;
  try {
    await checkRun({
      args: { platformDir: clone, out: dbPath, ci, json: false },
      rawArgs: [],
    });
  } catch (e) {
    if (e instanceof ExitError) {
      exitCode = e.code;
    } else {
      throw e;
    }
  }
  return exitCode;
}

function listRepoNames(): string[] {
  return listRepoNamesFromDb(dbPath);
}

const REAL_REPOS_SORTED = ["admin", "api", "mobile", "spec-engine"];

describe("`spec check --ci` cold-rebuild proof", () => {
  test("--ci cold-resets the DB (poisoned repos row is wiped post-check)", async () => {
    const s1 = openStorage(dbPath);
    try {
      await runIndex({ platformDir: clone, storage: s1 });
    } finally {
      s1.close();
    }

    const pre = listRepoNames().sort();
    expect(pre).toEqual(REAL_REPOS_SORTED);

    poisonRepoRow(dbPath, "__poisoned__");

    const poisoned = listRepoNames().sort();
    expect(poisoned).toContain("__poisoned__");
    expect(poisoned.length).toBe(REAL_REPOS_SORTED.length + 1);

    const exitCode = await runCheckWithFlags(true);
    // 1 comes from the fixture's planted diagnostics.
    expect(exitCode).toBe(1);

    const post = listRepoNames().sort();
    expect(post).toEqual(REAL_REPOS_SORTED);
    expect(post).not.toContain("__poisoned__");
  });

  test("--ci preserves the main DB inode (in-place cold reset, never an unlink)", async () => {
    const s1 = openStorage(dbPath);
    try {
      await runIndex({ platformDir: clone, storage: s1 });
    } finally {
      s1.close();
    }
    const preInode = statSync(dbPath).ino;

    poisonRepoRow(dbPath, "__poisoned_wal__");
    const exitCode = await runCheckWithFlags(true);
    expect(exitCode).toBe(1);

    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).ino).toBe(preInode);
    expect(listRepoNames()).not.toContain("__poisoned_wal__");
  });

  test("checkCommand WITHOUT --ci does NOT delete the DB (conditional branch lock)", async () => {
    const s1 = openStorage(dbPath);
    try {
      await runIndex({ platformDir: clone, storage: s1 });
    } finally {
      s1.close();
    }

    poisonRepoRow(dbPath, "__poisoned_no_ci__");
    expect(listRepoNames()).toContain("__poisoned_no_ci__");

    // runIndex's transactional clearAll wipes the poison row in-band without
    // --ci, so the reset is detected by its stderr log, not by the row.
    const exitCode = await runCheckWithFlags(false);
    expect(exitCode).toBe(1);

    expect(errs.some((m) => m.includes("cold-reset prior index"))).toBe(false);

    expect(existsSync(dbPath)).toBe(true);
    expect(listRepoNames()).not.toContain("__poisoned_no_ci__");
  });
});
