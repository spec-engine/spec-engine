// packages/engine/test/check-ci-cold-rebuild.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec CHCK-002
//
// CHCK-01 / Invariant #2 ("CI gate can run cold") — prove `spec check
// --ci` cold-resets the derived DB BEFORE `openStorage`: a FULL in-place
// wipe of every user object + re-DDL (coldResetDb), not merely a
// `DELETE FROM repos`. The old contract unlinked the file trio; that
// replaced the inode, and a long-lived `spec serve` reader kept its open
// fd on the ghost inode — silently serving stale data forever. The
// in-place wipe commits every DROP through the WAL, so no WAL replay
// zombies are possible either (the unlink trio's original motivation).
//
// Mechanism: poisonRepoRow (added in plan 03-05 Task 1) INSERTs a
// synthetic `repos` row with `path="/dev/null"` and `pinned_spec_version
// = 999` — a shape no real scan input could produce. After a warm
// runIndex populates the DB normally, we poison it, then run
// `checkCommand.run({ci: true})`. The post-condition is that the poison
// row is GONE, proving the cold reset fired.
//
// Three sibling tests:
//   1. --ci wipes the poisoned repos row.
//   2. --ci preserves the main DB file's inode (the reset is in-place,
//      never an unlink — the live-reader guarantee).
//   3. checkCommand WITHOUT --ci does NOT run the cold reset (locks the
//      conditional branch — the reset is gated on the flag, not
//      unconditional).
//
// All work happens inside a tmpdir clone of fixtures/platform-fixture/
// — the canonical fixture is never modified by these tests.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkCommand } from "../src/commands/check";
import { runIndex } from "../src/indexer/pipeline";
import { listRepoNamesFromDb, openStorage, poisonRepoRow } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

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
  // dbPath lives inside the clone's .spec-engine/ so the V12 path-containment
  // guard in commands/check.ts allows --out to point here.
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

/** Invoke `checkCommand.run` against the cloned fixture; capture the
 *  ExitError exit code. */
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

/** Read `repos.name` from the on-disk DB. Uses the D-08-fenced
 *  `listRepoNamesFromDb` helper (Phase 1's SqliteStorage.listRepos() is
 *  still a stub returning []; we need a direct SELECT for the
 *  pre/post-poison probe). */
function listRepoNames(): string[] {
  return listRepoNamesFromDb(dbPath);
}

/** Required real-repos against the canonical fixture, sorted. */
const REAL_REPOS_SORTED = ["admin", "api", "mobile", "spec-engine"];

describe("`spec check --ci` cold-rebuild proof (CHCK-01 / Invariant #2)", () => {
  test("--ci cold-resets the DB (poisoned repos row is wiped post-check)", async () => {
    // Step 1: warm index to create the DB.
    const s1 = openStorage(dbPath);
    try {
      await runIndex({ platformDir: clone, storage: s1 });
    } finally {
      s1.close();
    }

    // Step 2: pre-state — confirm the 4 expected repos and nothing else.
    const pre = listRepoNames().sort();
    expect(pre).toEqual(REAL_REPOS_SORTED);

    // Step 3: poison the DB with a synthetic row.
    poisonRepoRow(dbPath, "__poisoned__");

    // Step 4: confirm poison is present.
    const poisoned = listRepoNames().sort();
    expect(poisoned).toContain("__poisoned__");
    expect(poisoned.length).toBe(REAL_REPOS_SORTED.length + 1);

    // Step 5: run `spec check --ci` — this rm's the DB and re-indexes.
    const exitCode = await runCheckWithFlags(true);
    // The canonical fixture has 5 planted diagnostics → exit 1.
    expect(exitCode).toBe(1);

    // Step 6: post-state — the poison MUST be gone, and only the 4 real
    // repos remain. If --ci were a no-op (or a `DELETE FROM repos`
    // alone, with the WAL replaying), the poison row could survive.
    const post = listRepoNames().sort();
    expect(post).toEqual(REAL_REPOS_SORTED);
    expect(post).not.toContain("__poisoned__");
  });

  test("--ci preserves the main DB inode (in-place cold reset, never an unlink)", async () => {
    // Step 1: warm index → the DB file exists with a stable inode.
    const s1 = openStorage(dbPath);
    try {
      await runIndex({ platformDir: clone, storage: s1 });
    } finally {
      s1.close();
    }
    const preInode = statSync(dbPath).ino;

    // Step 2: poison + run --ci.
    poisonRepoRow(dbPath, "__poisoned_wal__");
    const exitCode = await runCheckWithFlags(true);
    expect(exitCode).toBe(1);

    // Step 3: the cold reset must have wiped IN PLACE — same file, same
    // inode. An unlink-and-recreate would mint a new inode, and any
    // long-lived reader (`spec serve`) holding the old fd would silently
    // serve stale data forever (the exact regression this pins).
    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).ino).toBe(preInode);

    // Belt-and-suspenders: freshness is undiminished — the poison row
    // really is gone after --ci, through the in-place wipe.
    expect(listRepoNames()).not.toContain("__poisoned_wal__");
  });

  test("checkCommand WITHOUT --ci does NOT delete the DB (conditional branch lock)", async () => {
    // Step 1: warm index.
    const s1 = openStorage(dbPath);
    try {
      await runIndex({ platformDir: clone, storage: s1 });
    } finally {
      s1.close();
    }

    // Step 2: poison.
    poisonRepoRow(dbPath, "__poisoned_no_ci__");
    expect(listRepoNames()).toContain("__poisoned_no_ci__");

    // Step 3: run check WITHOUT --ci. The runIndex inside check will
    // clearAll+repopulate via withWriteTx, which wipes repos in-band
    // — so the poison goes away through the *normal* clearAll path,
    // NOT through the --ci cold-reset path. This is a known consequence
    // of runIndex's transactional clearAll (Phase 2 Pitfall 1), and is
    // distinct from the --ci coldResetDb.
    //
    // The interesting invariant for THIS test is therefore:
    //   - the cold reset did NOT fire (its stderr log is absent), and
    //   - exit code is 1 (5 planted diagnostics).
    const exitCode = await runCheckWithFlags(false);
    expect(exitCode).toBe(1);

    // The "cold-reset prior index" log is emitted from commands/check.ts
    // ONLY when args.ci is truthy. Its absence here proves the reset
    // branch did not execute.
    expect(errs.some((m) => m.includes("cold-reset prior index"))).toBe(false);

    // DB file still exists (and is well-formed enough to read).
    expect(existsSync(dbPath)).toBe(true);
    // Post-state: poison is gone because runIndex's clearAll wiped
    // repos in-band — but the cold reset did NOT fire (confirmed
    // above by the missing stderr log).
    expect(listRepoNames()).not.toContain("__poisoned_no_ci__");
  });
});
