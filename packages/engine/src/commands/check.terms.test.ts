// @spec CHCK-016 integration
// @spec CHCK-017 integration
//
// The fixtures under testing/fixtures/diagnostics/{undefined-term,orphan-term,
// term-clean} carry deliberate defects (the ghost cite, the uncited term).
// Never "fix" them.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runIndex } from "../indexer/pipeline";
import { openStorage } from "../storage/sqlite";
import { cloneFixture } from "../testing/cloneFixture";
import { checkCommand } from "./check";

const FIXTURES_ROOT = resolve(import.meta.dir, "..", "testing", "fixtures", "diagnostics");
const UNDEFINED_TERM_FIXTURE = join(FIXTURES_ROOT, "undefined-term");
const ORPHAN_TERM_FIXTURE = join(FIXTURES_ROOT, "orphan-term");
const TERM_CLEAN_FIXTURE = join(FIXTURES_ROOT, "term-clean");

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

let tmp: string;
let dbPath: string;
let clones: string[];
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-check-terms-"));
  dbPath = join(tmp, "index.sqlite");
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
  rmSync(tmp, { recursive: true, force: true });
  for (const c of clones) {
    rmSync(c, { recursive: true, force: true });
  }
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const checkRun = (checkCommand as unknown as { run: RunFn }).run;

/** A clone, so the command's `.spec-engine/` never lands in the committed fixture. */
async function runCheckCi(fixtureDir: string): Promise<number> {
  const cloned = cloneFixture(fixtureDir);
  clones.push(cloned);
  const dbOut = join(cloned, ".spec-engine", "check.sqlite");
  let exitCode = -1;
  try {
    await checkRun({
      args: { platformDir: cloned, ci: true, json: true, out: dbOut },
      rawArgs: [],
    });
  } catch (e) {
    if (e instanceof ExitError) exitCode = e.code;
    else throw e;
  }
  return exitCode;
}

describe("UNDEFINED_TERM (error) — a cites entry resolving to no term", () => {
  test("fires with severity 'error' on the ghost citation", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: UNDEFINED_TERM_FIXTURE, storage: s });
      const rows = s.listSemanticDiagnostics();
      const hit = rows.find((d) => d.code === "UNDEFINED_TERM" && d.req_id === "BILLING-002");
      expect(hit).toBeDefined();
      expect(hit?.severity).toBe("error");
      expect(hit?.repo).toBeNull();
      expect(hit?.detail).toContain("Ghost");
      // The resolvable citation (BILLING-001 → TERM-001) does NOT fire.
      expect(rows.some((d) => d.code === "UNDEFINED_TERM" && d.req_id === "BILLING-001")).toBe(
        false,
      );
    } finally {
      s.close();
    }
  });

  test("`spec check --ci` exits 1 (error gates)", async () => {
    expect(await runCheckCi(UNDEFINED_TERM_FIXTURE)).toBe(1);
  });
});

describe("ORPHAN_TERM (warning) — an Active term no requirement cites", () => {
  test("fires with severity 'warning' on the uncited term", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: ORPHAN_TERM_FIXTURE, storage: s });
      const rows = s.listSemanticDiagnostics();
      const hit = rows.find((d) => d.code === "ORPHAN_TERM" && d.req_id === "TERM-001");
      expect(hit).toBeDefined();
      expect(hit?.severity).toBe("warning");
      expect(hit?.repo).toBeNull();
      expect(hit?.source_file).toContain("TERM/SPEC.json");
    } finally {
      s.close();
    }
  });

  test("`spec check --ci` stays exit 0 (warning does not gate)", async () => {
    expect(await runCheckCi(ORPHAN_TERM_FIXTURE)).toBe(0);
  });
});

describe("clean fixture — every citation resolves, every term cited", () => {
  test("neither UNDEFINED_TERM nor ORPHAN_TERM fires", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: TERM_CLEAN_FIXTURE, storage: s });
      const rows = s.listSemanticDiagnostics();
      expect(rows.some((d) => d.code === "UNDEFINED_TERM")).toBe(false);
      expect(rows.some((d) => d.code === "ORPHAN_TERM")).toBe(false);
    } finally {
      s.close();
    }
  });
});

describe("self-corpus — the real platform after the GLOSSARY migration", () => {
  test("migrated terms are uncited ORPHAN_TERM WARNINGS; UNDEFINED_TERM stays absent; gate exit 0", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: REPO_ROOT, storage: s });
      const rows = s.listSemanticDiagnostics();
      // No requirement cites a term yet (every `cites` is []), so a citation to
      // an unresolvable term can never fire.
      expect(rows.some((d) => d.code === "UNDEFINED_TERM")).toBe(false);
      // The terms migrated from GLOSSARY.md are not cited yet, so ORPHAN_TERM
      // fires for them; it must stay warning-severity or the self-gate reds.
      const orphans = rows.filter((d) => d.code === "ORPHAN_TERM");
      expect(orphans.length).toBeGreaterThan(0);
      expect(orphans.every((d) => d.severity === "warning")).toBe(true);
      expect(rows.some((d) => d.severity === "error")).toBe(false);
    } finally {
      s.close();
    }
  });
});
