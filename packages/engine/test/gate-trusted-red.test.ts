// packages/engine/test/gate-trusted-red.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec PROOF-003
//
// GATE-03 (green-suite-hides-removal) at the INTEGRATION layer — the headline
// proof that the trusted-red gate is more than presence-only. Two variants,
// both run in-process against a tmpdir clone of the canonical platform-fixture
// (the canonical fixture is never mutated — all deletes + generated JUnit land
// inside the clone; `rmSync` in afterEach).
//
// The controlled pair used throughout (verified against the live fixture):
//   R = BILLING-009 — active; impl tag in `api/src/renew.ts`, verifying tag in
//                     `api/test/renew.e2e.test.ts` (line 1). Clean: no other
//                     planted diagnostic touches BILLING-009.
//   S = BILLING-007 — active; verifying tags in `api/test/tax.test.ts` and
//                     `admin/test/reports.int.test.ts`. Its passing tests keep
//                     the "rest of the suite green" while we sink R.
//
// Baseline: R + S both PROVEN (their verifying test files PASS) → NO
//   UNPROVEN_REQ row for R. (Exit may still be 1 from the fixture's other
//   planted defects — we assert the SPECIFIC absence of an UNPROVEN_REQ for R.)
//
// Variant A (green-suite-hides-removal): delete R's `src/renew.ts` AND
//   `test/renew.e2e.test.ts`; supply an entirely-green JUnit (only S's passing
//   tests). R is now an active req with no passing verifying proof → exit 1
//   with R flagged. Nuance (documented in 19-RESEARCH § GATE-03): with BOTH
//   tags gone, R trips ORPHAN_REQ / UNVERIFIED_REQ (presence-mode codes), not
//   UNPROVEN_REQ — so we assert exit 1 AND that some diagnostic implicates R.
//
// Variant B (verifier-present-but-failing — the distinct trusted-red teeth):
//   keep R's verifying tag/file; supply a JUnit where R's testcase carries a
//   `<failure>` while every OTHER testcase passes (suite otherwise green) → a
//   SPECIFIC `UNPROVEN_REQ` row for R. This is exactly the case a presence-only
//   (`verified=1`) gate would wave through.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Diagnostic } from "@spec-engine/shared";
import { checkCommand } from "../src/commands/check";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

// The controlled provable pair (against the canonical fixture — no seeded
// member needed; verified via the live fixture's tags + SPEC.json statuses).
const R = "BILLING-009";
const R_IMPL = ["api", "src", "renew.ts"] as const;
const R_TEST = ["api", "test", "renew.e2e.test.ts"] as const;
// Tag `file` paths as the indexer records them (`${repo}/${relPath}`) — the
// JUnit `file=` attrs must suffix-match these for the 19-02 correlator.
const R_VERIFY_FILE = "api/test/renew.e2e.test.ts";
const S = "BILLING-007";
const S_VERIFY_FILES = ["api/test/tax.test.ts", "admin/test/reports.int.test.ts"] as const;

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

/** One JUnit `<testcase>` to render. `line` (when set) is >= the tag's @spec
 *  comment line so the correlator's line-proximity refinement keeps it. */
type Case = { file: string; name: string; line?: number; status: "pass" | "fail" | "skip" };

/** Render a minimal, well-formed JUnit document from a list of cases. Uses the
 *  flat jest/pytest shape (a single <testsuite>) with per-testcase `file=`. */
function junitXml(cases: Case[]): string {
  const rows = cases
    .map((c) => {
      const lineAttr = c.line !== undefined ? ` line="${c.line}"` : "";
      const head = `    <testcase name="${c.name}" file="${c.file}"${lineAttr}`;
      if (c.status === "pass") return `${head} />`;
      if (c.status === "fail")
        return `${head}>\n      <failure message="boom">assertion failed</failure>\n    </testcase>`;
      return `${head}>\n      <skipped />\n    </testcase>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="suite" tests="${cases.length}">\n${rows}\n  </testsuite>\n</testsuites>\n`;
}

let tmpScratch: string;
let clones: string[];
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

beforeEach(() => {
  tmpScratch = mkdtempSync(join(tmpdir(), "spec-gate-red-"));
  clones = [];
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
  rmSync(tmpScratch, { recursive: true, force: true });
  for (const c of clones) {
    rmSync(c, { recursive: true, force: true });
  }
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const checkRun = (checkCommand as unknown as { run: RunFn }).run;

/**
 * Write `cases` as a JUnit XML inside the clone (so the 19-03 `--results`
 * containment guard passes — it resolves against platformDir), then invoke
 * `checkCommand.run({ platformDir: clone, json: true, results })` in-process.
 * Returns the parsed diagnostic rows (stdout JSON array) + the exit code.
 */
async function runGate(
  clone: string,
  cases: Case[],
): Promise<{ got: Diagnostic[]; exitCode: number }> {
  const xmlPath = join(clone, "results.xml");
  writeFileSync(xmlPath, junitXml(cases));
  const rnd = Math.random().toString(36).slice(2, 10);
  const dbPath = join(clone, ".spec-engine", `test-${rnd}.sqlite`);
  logs.length = 0;
  errs.length = 0;
  let exitCode = -1;
  try {
    await checkRun({
      args: {
        platformDir: clone,
        out: dbPath,
        ci: false,
        json: true,
        results: "results.xml",
      },
      rawArgs: [],
    });
  } catch (e) {
    if (e instanceof ExitError) exitCode = e.code;
    else throw e;
  } finally {
    for (const sfx of ["", "-wal", "-shm"]) {
      rmSync(dbPath + sfx, { recursive: true, force: true });
    }
  }
  // In --json mode the build_id line is suppressed → logs[0] is the JSON array.
  const got = JSON.parse(logs[0] ?? "[]") as Diagnostic[];
  return { got, exitCode };
}

describe("GATE-03 green-suite-hides-removal (integration, both variants)", () => {
  test("baseline: R + S proven → NO UNPROVEN_REQ row for R", async () => {
    const clone = cloneFixture(FIXTURE);
    clones.push(clone);
    // All verifying test files PASS → R and S both PROVEN.
    const { got, exitCode } = await runGate(clone, [
      { file: R_VERIFY_FILE, name: "renew e2e", line: 2, status: "pass" },
      { file: S_VERIFY_FILES[0], name: "tax unit", line: 2, status: "pass" },
      { file: S_VERIFY_FILES[1], name: "reports integration", line: 2, status: "pass" },
    ]);
    // The fixture's other planted defects keep exit at 1 — but R must NOT be
    // UNPROVEN when its verifying test passes.
    expect(exitCode).toBe(1);
    expect(got.some((d) => d.code === "UNPROVEN_REQ" && d.req_id === R)).toBe(false);
    expect(got.some((d) => d.code === "UNPROVEN_REQ" && d.req_id === S)).toBe(false);
  });

  test("variant A: deleting R's impl + verifying files → exit 1 with R flagged, suite all-green", async () => {
    const clone = cloneFixture(FIXTURE);
    clones.push(clone);
    // Remove R's implementing code AND its verifying test from the clone.
    rmSync(join(clone, ...R_IMPL));
    rmSync(join(clone, ...R_TEST));
    // Entirely-green JUnit — only S's passing tests remain.
    const { got, exitCode } = await runGate(clone, [
      { file: S_VERIFY_FILES[0], name: "tax unit", line: 2, status: "pass" },
      { file: S_VERIFY_FILES[1], name: "reports integration", line: 2, status: "pass" },
    ]);
    // A green suite cannot hide the removal: check still goes RED, R flagged.
    expect(exitCode).toBe(1);
    expect(got.some((d) => d.req_id === R)).toBe(true);
    // Nuance: with BOTH tags gone R has no verifying tag → it is ORPHAN_REQ /
    // UNVERIFIED_REQ (presence-mode codes), NOT UNPROVEN_REQ (which requires a
    // surviving verifying tag). Variant B covers the UNPROVEN_REQ teeth.
    expect(got.some((d) => d.code === "UNPROVEN_REQ" && d.req_id === R)).toBe(false);
  });

  test("variant B: verifier present but its test FAILS (rest green) → specific UNPROVEN_REQ for R", async () => {
    const clone = cloneFixture(FIXTURE);
    clones.push(clone);
    // R's verifying tag/file stays in place; its testcase FAILS while every
    // other testcase passes — the distinct trusted-red case presence can't catch.
    const { got, exitCode } = await runGate(clone, [
      { file: R_VERIFY_FILE, name: "renew e2e", line: 2, status: "fail" },
      { file: S_VERIFY_FILES[0], name: "tax unit", line: 2, status: "pass" },
      { file: S_VERIFY_FILES[1], name: "reports integration", line: 2, status: "pass" },
    ]);
    expect(exitCode).toBe(1);
    // The headline assertion: a SPECIFIC UNPROVEN_REQ row for R.
    expect(got.some((d) => d.code === "UNPROVEN_REQ" && d.req_id === R)).toBe(true);
    // S stays proven (its tests passed) — the gate is precise, not always-red.
    expect(got.some((d) => d.code === "UNPROVEN_REQ" && d.req_id === S)).toBe(false);
  });
});
