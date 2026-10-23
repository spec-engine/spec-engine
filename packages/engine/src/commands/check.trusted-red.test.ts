// @spec PROOF-020 integration

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Diagnostic } from "@spec-engine/shared";
import { cloneFixture } from "../testing/cloneFixture";
import { checkCommand } from "./check";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

// The canonical fixture's provable pair. R: active, impl tag in
// api/src/renew.ts, verifying tag in api/test/renew.e2e.test.ts, touched by
// no other planted diagnostic. S: active, verified by two test files whose
// passing tests keep the rest of the suite green.
const R = "BILLING-009";
const R_IMPL = ["api", "src", "renew.ts"] as const;
const R_TEST = ["api", "test", "renew.e2e.test.ts"] as const;
// Tag `file` paths as the indexer records them (`${repo}/${relPath}`): the
// JUnit `file=` attrs must suffix-match these for the correlator.
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

/** The XML is written inside the clone so the `--results` containment guard passes. */
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

describe("green-suite-hides-removal (integration, both variants)", () => {
  test("baseline: R + S proven → NO UNPROVEN_REQ row for R", async () => {
    const clone = cloneFixture(FIXTURE);
    clones.push(clone);
    const { got, exitCode } = await runGate(clone, [
      { file: R_VERIFY_FILE, name: "renew e2e", line: 2, status: "pass" },
      { file: S_VERIFY_FILES[0], name: "tax unit", line: 2, status: "pass" },
      { file: S_VERIFY_FILES[1], name: "reports integration", line: 2, status: "pass" },
    ]);
    // The fixture's other planted defects keep exit at 1.
    expect(exitCode).toBe(1);
    expect(got.some((d) => d.code === "UNPROVEN_REQ" && d.req_id === R)).toBe(false);
    expect(got.some((d) => d.code === "UNPROVEN_REQ" && d.req_id === S)).toBe(false);
  });

  test("variant A: deleting R's impl + verifying files → exit 1 with R flagged, suite all-green", async () => {
    const clone = cloneFixture(FIXTURE);
    clones.push(clone);
    rmSync(join(clone, ...R_IMPL));
    rmSync(join(clone, ...R_TEST));
    const { got, exitCode } = await runGate(clone, [
      { file: S_VERIFY_FILES[0], name: "tax unit", line: 2, status: "pass" },
      { file: S_VERIFY_FILES[1], name: "reports integration", line: 2, status: "pass" },
    ]);
    expect(exitCode).toBe(1);
    expect(got.some((d) => d.req_id === R)).toBe(true);
    // With both tags gone R trips the presence codes (ORPHAN_REQ /
    // UNVERIFIED_REQ); UNPROVEN_REQ needs a surviving verifying tag.
    expect(got.some((d) => d.code === "UNPROVEN_REQ" && d.req_id === R)).toBe(false);
  });

  test("variant B: verifier present but its test FAILS (rest green) → specific UNPROVEN_REQ for R", async () => {
    const clone = cloneFixture(FIXTURE);
    clones.push(clone);
    const { got, exitCode } = await runGate(clone, [
      { file: R_VERIFY_FILE, name: "renew e2e", line: 2, status: "fail" },
      { file: S_VERIFY_FILES[0], name: "tax unit", line: 2, status: "pass" },
      { file: S_VERIFY_FILES[1], name: "reports integration", line: 2, status: "pass" },
    ]);
    expect(exitCode).toBe(1);
    expect(got.some((d) => d.code === "UNPROVEN_REQ" && d.req_id === R)).toBe(true);
    expect(got.some((d) => d.code === "UNPROVEN_REQ" && d.req_id === S)).toBe(false);
  });
});
