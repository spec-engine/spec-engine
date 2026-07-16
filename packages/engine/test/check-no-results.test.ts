// packages/engine/test/check-no-results.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec PROOF-005
//
// GATE-05 (Phase 19, Plan 19-03) — the no-`--results` gradual-adoption
// fallback, asserted at the in-process `checkCommand.run` layer.
//
// The trusted-red gate is OPT-IN: running `spec check` WITHOUT `--results`
// must preserve today's behavior byte-for-byte. This test locks the two
// invariants that make gradual adoption safe:
//
//   1. **--json stdout baseline is byte-unchanged** (Pitfall 3 / T-19-12):
//      with no `--results`, the JSON diagnostic array emitted to STDOUT equals
//      the exact same canonical planted-defect set as check-ci.test.ts — the
//      PROOFS_UNCONFIRMED advisory is NOT an element of that array. It goes to
//      STDERR instead, so ci.yml smoke 7 / smoke 18 (which `JSON.parse` stdout)
//      stay green. This test asserts BOTH: the array matches, AND the advisory
//      lands in captured stderr.
//
//   2. **Exit code is byte-preserved.** No `--results` never changes the exit
//      code: against the planted-defect fixture it is still 1 (from the
//      pre-existing error-severity diagnostics), and the warning-severity
//      PROOFS_UNCONFIRMED can never flip it — in text mode the warning row IS
//      present in stdout but the exit stays 1.
//
// Harness cloned from check-ci.test.ts (ExitError exit stub, console.log /
// console.error capture, cloneFixture + rmSync-in-afterEach discipline, the
// `normalize()` projection). Tests never touch fixtures/platform-fixture/ in
// place — all runs are against a tmpdir clone.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Diagnostic, DiagnosticCode } from "@spec-engine/shared";
import { checkCommand } from "../src/commands/check";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

// SOURCE OF TRUTH for the planted defect set against the canonical fixture.
// Re-declared here (mirroring check-ci.test.ts) so the GATE-05 no-results path
// is proven to leave the exact same 6-row --json stdout baseline — i.e. the
// PROOFS_UNCONFIRMED advisory must NOT appear as an element of this array.
const EXPECTED_DIAGNOSTICS: Array<{
  code: DiagnosticCode;
  repo: string | null;
  req_id: string | null;
}> = [
  { code: "DANGLING_TAG", repo: "admin", req_id: "BILLING-999" },
  { code: "DRIFT", repo: "mobile", req_id: "BILLING-001" },
  { code: "ORPHAN_REQ", repo: null, req_id: "AUTH-001" },
  { code: "SUPERSEDED_REFERENCED", repo: "mobile", req_id: "BILLING-001" },
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
  tmpScratch = mkdtempSync(join(tmpdir(), "spec-check-nores-"));
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
 * Invoke checkCommand.run in-process with NO `results` arg. Returns the full
 * captured stdout (all `console.log` rows joined by newline — text mode emits
 * a diagnostic block + a build_id line), the raw log rows, and the exit code
 * surfaced by the ExitError stub. The DB lives inside the clone's tmpdir.
 */
async function runCheck(opts: {
  platformDir: string;
  ci?: boolean;
  json?: boolean;
}): Promise<{ stdout: string; exitCode: number }> {
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
        // NOTE: deliberately NO `results` key — this is the GATE-05 path.
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
  return { stdout: logs.join("\n"), exitCode };
}

/** Projection to the comparable (code, repo, req_id) shape, sorted for
 *  byte-stable equality — identical to check-ci.test.ts. */
function normalize(rows: Array<Pick<Diagnostic, "code" | "repo" | "req_id">>): string[] {
  return rows.map((d) => `${d.code}\t${d.repo ?? ""}\t${d.req_id ?? ""}`).sort();
}

describe("GATE-05: no --results preserves the --json stdout baseline", () => {
  test("--json --ci with NO results → stdout array == canonical set; PROOFS_UNCONFIRMED on stderr; exit 1", async () => {
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);

    const { exitCode } = await runCheck({ platformDir: cloned, ci: true, json: true });

    // In --json mode logs[0] is the diagnostic array; the build_id line is
    // suppressed, so there is exactly one stdout row.
    const got = JSON.parse(logs[0] ?? "") as Diagnostic[];

    // (1) The --json stdout array is byte-stable: exactly the canonical planted
    //     set, with NO PROOFS_UNCONFIRMED element (it went to stderr).
    expect(normalize(got)).toEqual(normalize(EXPECTED_DIAGNOSTICS));
    expect(got.length).toBe(EXPECTED_DIAGNOSTICS.length);
    expect(got.some((d) => d.code === "PROOFS_UNCONFIRMED")).toBe(false);

    // (2) The advisory was emitted — to STDERR, not the array.
    expect(
      errs.some(
        (m) => m.includes("PROOFS_UNCONFIRMED") || m.toLowerCase().includes("proofs unconfirmed"),
      ),
    ).toBe(true);

    // (3) Exit code byte-preserved: still 1 against the planted-defect fixture.
    expect(exitCode).toBe(1);
  });
});

describe("GATE-05: no --results in text mode shows a warning row, exit unchanged", () => {
  test("--ci (text) with NO results → PROOFS_UNCONFIRMED row in stdout; exit still 1", async () => {
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);

    const { stdout, exitCode } = await runCheck({ platformDir: cloned, ci: true, json: false });

    // Text mode: the warning row IS visible in stdout (unlike --json, where it
    // is suppressed to stderr to keep the array byte-stable).
    expect(stdout).toContain("PROOFS_UNCONFIRMED");

    // A warning-severity diagnostic never flips the exit — still 1 from the
    // pre-existing error-severity planted defects.
    expect(exitCode).toBe(1);
  });
});
