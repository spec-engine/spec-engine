// @spec CHCK-012
// @spec CHCK-013

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Diagnostic } from "@spec-engine/shared";
import baseline from "../../../../fixtures/platform-fixture.diagnostics.json" with { type: "json" };
import { cloneFixture } from "../testing/cloneFixture";
import { specTag } from "../testing/specTag";
import { checkCommand } from "./check";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

/** The planted defect set, the one file the smokes under scripts/smoke/ read too. */
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
 * The DB lands under `platformDir/.spec-engine/` (the --out containment
 * guard demands it), so callers pass a clone, never the canonical fixture.
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
  // --json suppresses the build_id line, so logs[0] is the whole array.
  return { stdout: logs[0] ?? "", exitCode };
}

type ExpectedDiagnostic = { code: string; repo: string | null; req_id: string | null };

function normalize(rows: ReadonlyArray<ExpectedDiagnostic | Diagnostic>): string[] {
  return rows.map((d) => `${d.code}\t${d.repo ?? ""}\t${d.req_id ?? ""}`).sort();
}

describe("Inverted CI assertion", () => {
  test("checkCommand --ci --json against canonical fixture → exact diagnostic set", async () => {
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
    expect(got.length).toBe(EXPECTED_DIAGNOSTICS.length);
  });

  test("severity matches the per-code contract across the diagnostic set", async () => {
    const WARNING_CODES = new Set([
      "BROKEN_RELATES",
      "RELATES_SUPERSEDED",
      "NO_SPEC_CONFIG",
      "UNKNOWN_ROLE",
      // @spec CHCK-035 unit
      "UNVERIFIED_REQ",
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

describe("Inverted self-test (honesty proof)", () => {
  test("stripping the BILLING-999 tag from a CLONED fixture causes the exact-match to FAIL", async () => {
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);

    const reportsPath = join(cloned, "admin", "src", "reports.ts");
    const original = readFileSync(reportsPath, "utf8");
    const stripped = original
      .split("\n")
      .filter((line) => !line.includes("BILLING-999"))
      .join("\n");
    writeFileSync(reportsPath, stripped);
    expect(readFileSync(reportsPath, "utf8")).not.toContain("BILLING-999");

    const { stdout, exitCode } = await runCheck({
      platformDir: cloned,
      ci: true,
      json: true,
    });

    expect(exitCode).toBe(1);
    const got = JSON.parse(stdout) as Diagnostic[];

    // Without this, the exact-match assertion could pass for the wrong
    // reason, such as an empty set compared against an empty set.
    expect(() => {
      expect(normalize(got)).toEqual(normalize(EXPECTED_DIAGNOSTICS));
    }).toThrow();
  });
});

describe("Fixture self-check (defense against sloppy fixture edits)", () => {
  // A one-line "the fixture lost its planted defect" failure, ahead of the
  // opaque diagnostic-set diff.
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
