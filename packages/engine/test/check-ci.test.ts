// packages/engine/test/check-ci.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec CHCK-001
//
// CHCK-04 / CI-03 — the inverted CI assertion (proves CHCK-001/CHCK-002) at
// the in-process layer. The headline test of Phase 3.
//
// Three sibling tests:
//
//   1. **Inverted CI assertion** (CHCK-04 / CI-03):
//      Run `checkCommand.run({platformDir: FIXTURE, ci: true, json: true})`
//      in-process against the canonical fixture, project the JSON output
//      to comparable keys, sort, and assert EXACT equality against the
//      planted 5-row diagnostic set. Adding a 6th diagnostic OR removing
//      one fails the assertion. CHCK-05 is implicitly covered — if the
//      negative-DRIFT case (mobile@1 / BILLING-007) fired, count would be
//      6, not 5, and the exact-match would mismatch.
//
//   2. **Inverted self-test** (the test that proves the test is honest):
//      Clone the canonical fixture into a tmpdir, strip the `@spec
//      BILLING-999` line from `admin/src/reports.ts`, re-run check, and
//      assert the exact-match assertion would now FAIL (via the
//      meta-pattern `expect(() => expect(...).toEqual(...)).toThrow()`).
//      Without this test, the inverted assertion could pass for the wrong
//      reason (e.g. it asserts the empty set against the empty set).
//
//   3. **Fixture self-check** (defense against sloppy fixture edits):
//      Read `fixtures/platform-fixture/admin/src/reports.ts` directly and
//      assert it literally contains the BILLING-999 tag. Similar
//      invariant strings for `mobile/src/billing.ts`,
//      `spec-engine/BILLING/SPEC.json`, and `mobile/spec-engine.member.json`. If
//      a future fixture edit drops a planted defect, this test fails with
//      a clear single-line message instead of an opaque diagnostic-set
//      diff in Test 1.
//
// Tests do NOT modify `fixtures/platform-fixture/` — all mutations happen
// in a tmpdir clone via the `cloneFixture` helper (D-08-adjacent
// invariant: canonical fixture is read-only across the test suite).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Diagnostic, DiagnosticCode } from "@spec-engine/shared";
import { checkCommand } from "../src/commands/check";
import { cloneFixture } from "./fixtures/cloneFixture";
import { specTag } from "./fixtures/specTag";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

// SOURCE OF TRUTH for the planted defect set against the canonical fixture
// (per 03-RESEARCH § Open Question 3). If Phase 4 grows the fixture, this
// constant updates in exactly one place. The CI yml smoke 7 (plan 03-06)
// duplicates this enumeration as defense-in-depth — that's intentional.
const EXPECTED_DIAGNOSTICS: Array<{
  code: DiagnosticCode;
  repo: string | null;
  req_id: string | null;
}> = [
  { code: "DANGLING_TAG", repo: "admin", req_id: "BILLING-999" },
  { code: "DRIFT", repo: "mobile", req_id: "BILLING-001" },
  { code: "ORPHAN_REQ", repo: null, req_id: "AUTH-001" },
  { code: "SUPERSEDED_REFERENCED", repo: "mobile", req_id: "BILLING-001" },
  // PFIX-01 (Phase 12, Plan 12-04): the canonical fixture seeds a malformed
  // `**Issues:** ... bogus-no-colon ...` token on BILLING-002, which the
  // provenance parser surfaces as a warning-severity UNKNOWN_ROLE diagnostic
  // (PROV-05: surfaced at parse time AND dropped — never stored). It is part
  // of the planted-mess baseline, so it joins the inverted-CI expected set.
  { code: "UNKNOWN_ROLE", repo: null, req_id: "BILLING-002" },
  { code: "UNVERIFIED_REQ", repo: null, req_id: "BILLING-002" },
];

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

let tmpScratch: string;
let clones: string[];
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

beforeEach(() => {
  tmpScratch = mkdtempSync(join(tmpdir(), "spec-check-ci-"));
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
  // process.exit is typed `(code?: number) => never`; the stub throws so we
  // can `try { ... } catch (ExitError) { ... }` and inspect the exit code
  // instead of terminating the test runner. Mirrors cli-new.test.ts.
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
 * Invoke checkCommand.run in-process against `platformDir` with the
 * supplied flags. Captures stdout (the diagnostic stream) and the
 * process.exit code surfaced by the ExitError stub.
 *
 * WR-07 review-fix: the DB lives inside `tmpScratch` (an `os.tmpdir()`
 * scratch dir created in beforeEach), NOT inside platformDir. Previously
 * the DB path lived at `<platformDir>/.spec-engine/test-<rnd>.sqlite`, which
 * for the canonical-fixture Test 1 created a `.spec-engine/` directory inside
 * `fixtures/platform-fixture/` on every test run (the V12 containment
 * guard demanded it). That left stray directories behind and exposed
 * the canonical fixture to the shared-mutable-state problem under
 * parallel `bun test` workers. The fix: switch the canonical-fixture
 * tests to operate against a clone (so their `.spec-engine/` is inside the
 * clone's tmpdir), and keep the inverted-self-test as-is (it was
 * already using a clone).
 *
 * The dbPath stays under whatever platformDir caller provides so the
 * V12 containment guard remains exercised.
 */
async function runCheck(opts: {
  platformDir: string;
  ci?: boolean;
  json?: boolean;
}): Promise<{ stdout: string; exitCode: number }> {
  // Random suffix avoids cross-test collisions when multiple invocations
  // share a platformDir. The .spec-engine/ dir lives inside opts.platformDir;
  // callers are responsible for using a clone if they don't want
  // canonical-fixture mutation (Test 1 below does exactly that).
  const rnd = Math.random().toString(36).slice(2, 10);
  const dbPath = join(opts.platformDir, ".spec-engine", `test-${rnd}.sqlite`);
  let exitCode = -1;
  try {
    await checkRun({
      args: {
        platformDir: opts.platformDir,
        ci: opts.ci ?? false,
        json: opts.json ?? false,
        out: dbPath,
      },
      rawArgs: [],
    });
  } catch (e) {
    if (e instanceof ExitError) {
      exitCode = e.code;
    } else {
      throw e;
    }
  } finally {
    for (const sfx of ["", "-wal", "-shm"]) {
      rmSync(dbPath + sfx, { recursive: true, force: true });
    }
  }
  // logs[0] is the JSON diagnostic array (when --json); the build_id line is
  // suppressed in JSON mode (per commands/check.ts), so logs has exactly one
  // entry in JSON mode.
  return { stdout: logs[0] ?? "", exitCode };
}

/** Projection from Diagnostic[] to the comparable (code, repo, req_id) shape
 *  used by the exact-match assertion. Sorted for byte-stable equality. */
function normalize(rows: Array<Pick<Diagnostic, "code" | "repo" | "req_id">>): string[] {
  return rows.map((d) => `${d.code}\t${d.repo ?? ""}\t${d.req_id ?? ""}`).sort();
}

describe("Inverted CI assertion (CHCK-04 / CI-03)", () => {
  test("checkCommand --ci --json against canonical fixture → exact diagnostic set", async () => {
    // WR-07 review-fix: run against a clone so the .spec-engine/ dir the
    // command creates does not land inside fixtures/platform-fixture/.
    // The clone still captures every planted defect (cpSync is deep)
    // so the inverted CI assertion's content semantics are identical.
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);
    const { stdout, exitCode } = await runCheck({
      platformDir: cloned,
      ci: true,
      json: true,
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBeTruthy();

    const got = JSON.parse(stdout) as Diagnostic[];
    expect(normalize(got)).toEqual(normalize(EXPECTED_DIAGNOSTICS));
    // Belt-and-suspenders: count must match the planted-mess baseline exactly.
    // If CHCK-05 negative case (mobile@1 / BILLING-007) regressed, the set
    // would gain a row and the exact-match above would already mismatch.
    expect(got.length).toBe(EXPECTED_DIAGNOSTICS.length);
  });

  test("severity matches the per-code contract across the diagnostic set", async () => {
    // WR-07: same cloning rationale as the previous test. RED-16: the
    // Relates diagnostics are warnings; every other semantic/structural
    // code in the canonical fixture is error-severity. Per-code assertion
    // replaces the pre-RED-16 blanket 'always error'.
    const WARNING_CODES = new Set([
      "BROKEN_RELATES",
      "RELATES_SUPERSEDED",
      "NO_SPEC_CONFIG",
      // Q4 (Phase 18): the index-time BROKEN_FILE_REF check is retired with the
      // Markdown parse path, so it is no longer part of the warning set.
      // PROV-05 (Phase 12): malformed/unknown-role `**Issues:**` tokens are
      // advisory — surfaced and dropped, never stored. Warning severity.
      "UNKNOWN_ROLE",
    ]);
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);
    const { stdout } = await runCheck({
      platformDir: cloned,
      ci: true,
      json: true,
    });
    const got = JSON.parse(stdout) as Diagnostic[];
    expect(got.length).toBeGreaterThan(0);
    for (const d of got) {
      expect(d.severity).toBe(WARNING_CODES.has(d.code) ? "warning" : "error");
    }
  });
});

describe("Inverted self-test (CHCK-04 honesty proof)", () => {
  test("stripping the BILLING-999 tag from a CLONED fixture causes the exact-match to FAIL", async () => {
    // Clone canonical fixture into a writable tmpdir. We MUST NOT touch
    // fixtures/platform-fixture/ in-place — that would silently corrupt
    // every other test in the suite.
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);

    // Strip the planted dangling-tag line from the clone.
    const reportsPath = join(cloned, "admin", "src", "reports.ts");
    const original = readFileSync(reportsPath, "utf8");
    const stripped = original
      .split("\n")
      .filter((line) => !line.includes("BILLING-999"))
      .join("\n");
    writeFileSync(reportsPath, stripped);
    // Sanity check: the line really is gone in the clone.
    expect(readFileSync(reportsPath, "utf8")).not.toContain("BILLING-999");

    const { stdout, exitCode } = await runCheck({
      platformDir: cloned,
      ci: true,
      json: true,
    });

    // The DANGLING_TAG diagnostic is gone, so:
    //  - Either exitCode is now 0 (only DANGLING_TAG was an error, but
    //    other 4 still are → exit will still be 1; that's fine).
    //  - OR exitCode is 1 but with 4 rows, not 5.
    // We don't pin the exact remaining count — the point is that the
    // EXACT-MATCH assertion from Test 1 must FAIL.
    expect(exitCode).toBe(1);
    const got = JSON.parse(stdout) as Diagnostic[];

    // Meta-assertion: comparing the now-different got[] against
    // EXPECTED_DIAGNOSTICS MUST throw. If this `expect(() => ...).toThrow()`
    // itself did NOT throw, the inverted CI assertion in Test 1 would be
    // a no-op against an empty set or a non-strict comparison — which is
    // exactly the failure mode CHCK-04 exists to prevent.
    expect(() => {
      expect(normalize(got)).toEqual(normalize(EXPECTED_DIAGNOSTICS));
    }).toThrow();
  });
});

describe("Fixture self-check (defense against sloppy fixture edits)", () => {
  // These tests read the CANONICAL fixture directly — no clone, no check
  // invocation. Their job is to give a clear "the fixture lost its
  // planted defect" failure message before Test 1's diagnostic-diff
  // assertion gets a chance to muddy the waters.

  test("admin/src/reports.ts contains the planted BILLING-999 tag", () => {
    const path = join(FIXTURE, "admin", "src", "reports.ts");
    const body = readFileSync(path, "utf8");
    expect(body).toContain(specTag("BILLING-999").trimEnd());
  });

  test("mobile/src/billing.ts contains the planted BILLING-001 tag", () => {
    const path = join(FIXTURE, "mobile", "src", "billing.ts");
    const body = readFileSync(path, "utf8");
    expect(body).toContain(specTag("BILLING-001").trimEnd());
  });

  test("spec-engine/BILLING/SPEC.json declares BILLING-001 as Superseded", () => {
    // Fixture migrated to JSON in 18-03: the "Superseded by BILLING-009" Markdown
    // status form becomes the structured { status: "superseded", supersededBy:
    // "BILLING-009" } envelope shape.
    const path = join(FIXTURE, "spec-engine", "BILLING", "SPEC.json");
    const spec = JSON.parse(readFileSync(path, "utf8"));
    const b1 = spec.requirements.find((r: { id: string }) => r.id === "BILLING-001");
    expect(b1?.status).toBe("superseded");
    expect(b1?.supersededBy).toBe("BILLING-009");
  });

  test("mobile/spec-engine.member.json pins spec-engine@1 (locks the DRIFT case)", () => {
    const path = join(FIXTURE, "mobile", "spec-engine.member.json");
    const body = readFileSync(path, "utf8");
    expect(body).toContain("spec-engine@1");
  });
});
