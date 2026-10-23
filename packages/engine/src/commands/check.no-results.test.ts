// @spec PROOF-018
//
// Under --json the PROOFS_UNCONFIRMED advisory must stay off stdout: smokes
// 7 and 18 under scripts/smoke/ parse that array against the baseline.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Diagnostic } from "@spec-engine/shared";
import baseline from "../../../../fixtures/platform-fixture.diagnostics.json" with { type: "json" };
import { cloneFixture } from "../testing/cloneFixture";
import { checkCommand } from "./check";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

/** The planted defect set from the shared baseline file; PROOFS_UNCONFIRMED is never an element of it. */
const EXPECTED_DIAGNOSTICS: ExpectedDiagnostic[] = baseline;

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
        // Deliberately no `results` key.
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

type ExpectedDiagnostic = { code: string; repo: string | null; req_id: string | null };

function normalize(rows: ReadonlyArray<ExpectedDiagnostic | Diagnostic>): string[] {
  return rows.map((d) => `${d.code}\t${d.repo ?? ""}\t${d.req_id ?? ""}`).sort();
}

describe("no --results preserves the --json stdout baseline", () => {
  test("--json --ci with NO results → stdout array == canonical set; PROOFS_UNCONFIRMED on stderr; exit 1", async () => {
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);

    const { exitCode } = await runCheck({ platformDir: cloned, ci: true, json: true });

    // --json suppresses the build_id line, so there is exactly one stdout row.
    const got = JSON.parse(logs[0] ?? "") as Diagnostic[];

    expect(normalize(got)).toEqual(normalize(EXPECTED_DIAGNOSTICS));
    expect(got.length).toBe(EXPECTED_DIAGNOSTICS.length);
    expect(got.some((d) => d.code === "PROOFS_UNCONFIRMED")).toBe(false);

    expect(
      errs.some(
        (m) => m.includes("PROOFS_UNCONFIRMED") || m.toLowerCase().includes("proofs unconfirmed"),
      ),
    ).toBe(true);

    expect(exitCode).toBe(1);
  });
});

describe("no --results in text mode shows a warning row, exit unchanged", () => {
  test("--ci (text) with NO results → PROOFS_UNCONFIRMED row in stdout; exit still 1", async () => {
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);

    const { stdout, exitCode } = await runCheck({ platformDir: cloned, ci: true, json: false });

    expect(stdout).toContain("PROOFS_UNCONFIRMED");

    // 1 comes from the planted error-severity defects.
    expect(exitCode).toBe(1);
  });
});
