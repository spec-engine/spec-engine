// packages/engine/test/check-results-ci.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec PROOF-004
//
// GATE-04 at the INTEGRATION layer: `spec check --ci --results <xml>` (1) exits
// non-zero on any unproven active requirement, and (2) `build_id` is BYTE-
// IDENTICAL across two cold `--ci` runs that differ ONLY by whether `--results`
// is supplied. The parity proof is the load-bearing GATE-04 guarantee: results
// ingestion happens AFTER `runIndex` computes `build_id`, so it can never
// perturb the cold-build hash (temporal isolation — 19-RESEARCH § Cold-Build
// Safety). Both runs are cold (`--ci` rm-trio) so the comparison never leans on
// a warm/stale index.
//
// All work happens inside a tmpdir clone of the canonical platform-fixture —
// the canonical fixture is never modified (`rmSync` in afterEach).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
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

let clone: string;
let dbPath: string;
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

beforeEach(() => {
  clone = cloneFixture(FIXTURE);
  // dbPath lives inside the clone's .spec-engine/ so the V12 --out containment guard
  // in commands/check.ts allows it.
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

/** Write `xml` into the clone and return the platformDir-relative path (so the
 *  19-03 `--results` containment guard passes). */
function writeResults(xml: string): string {
  const rel = "results.xml";
  writeFileSync(join(clone, rel), xml);
  return rel;
}

/**
 * Invoke `checkCommand.run` against the clone with the supplied flags. `logs`
 * is reset per call so multiple invocations in one test stay isolated. Returns
 * the captured stdout lines + the exit code surfaced by the ExitError stub.
 */
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

/** Extract the `build_id: <hash>` value from captured stdout (text mode only —
 *  the line is suppressed in --json mode). */
function extractBuildId(captured: string[]): string {
  const line = captured.find((l) => l.startsWith("build_id:"));
  expect(line).toBeDefined();
  return (line as string).slice("build_id:".length).trim();
}

describe("GATE-04 --ci --results (integration): exit code + build_id parity", () => {
  test("--ci --results exits 1 with ≥1 UNPROVEN_REQ when an active req is unproven", async () => {
    // A green-but-UNRELATED suite: it proves NEITHER BILLING-009 nor BILLING-007
    // (both active, both have verifying tags) → both surface UNPROVEN_REQ.
    const results = writeResults(
      `<?xml version="1.0"?>\n<testsuite name="unrelated" tests="1">\n  <testcase name="noop" file="api/test/unrelated.test.ts" line="1" />\n</testsuite>\n`,
    );
    const { logs: out, exitCode } = await runCheck({ ci: true, json: true, results });
    expect(exitCode).toBe(1);
    const got = JSON.parse(out[0] ?? "[]") as Diagnostic[];
    expect(got.some((d) => d.code === "UNPROVEN_REQ")).toBe(true);
  });

  test("build_id is byte-identical WITH vs WITHOUT --results across two cold --ci runs", async () => {
    // Run 1 (cold, text mode, NO results): capture build_id.
    const run1 = await runCheck({ ci: true, json: false });
    const hWithout = extractBuildId(run1.logs);

    // Run 2 (cold, text mode, WITH results): same clone, --ci rm-trio rebuilds
    // the DB from scratch → the ONLY difference is --results.
    const results = writeResults(
      `<?xml version="1.0"?>\n<testsuite name="unrelated" tests="1">\n  <testcase name="noop" file="api/test/unrelated.test.ts" line="1" />\n</testsuite>\n`,
    );
    const run2 = await runCheck({ ci: true, json: false, results });
    const hWith = extractBuildId(run2.logs);

    // Temporal isolation: results ingestion happens after runIndex → the hash
    // cannot move. A results-persisted-into-hash regression would fail here.
    expect(hWith).toBe(hWithout);
    // Shape sanity: a 64-char lowercase hex SHA-256.
    expect(hWith).toMatch(/^[0-9a-f]{64}$/);
  });
});
