// packages/engine/test/check-terms.test.ts
//
// Phase 6 Wave D (TERM-04, dogfooded in CHCK). The two reference-integrity
// diagnostics over the term store:
//
//   - UNDEFINED_TERM (error):  a `cites` entry that resolves to no TERM
//     (term_id NULL via LEFT JOIN) — the §4.10 "left to interpretation, now
//     caught" payoff. ERROR severity, so it flips `spec check --ci` to exit 1.
//   - ORPHAN_TERM (warning):   an Active TERM entry that no requirement cites
//     (glossary rot). WARNING severity, so a freshly-migrated/uncited term
//     keeps `spec check --ci` at exit 0 (Wave-F migrates ~30 fresh terms at
//     once — an error would red the gate the instant GLOSSARY.md lands).
//
// The fixtures under fixtures/diagnostics/{undefined-term,orphan-term,
// term-clean} are PLANTED test data — they carry the deliberate defects
// (the ghost cite, the uncited term) so `spec check` has something to catch.
// Never "fix" them. Their @spec-free SPEC.json rows never index into THIS
// repo's real corpus (the scanner ignores every `fixtures/` subtree).
//
// Content + severity are asserted through openStorage + runIndex +
// listSemanticDiagnostics (mirrors check-diagnostics.test.ts); the exit-code
// behavior is asserted through checkCommand.run against a CLONE (mirrors
// check-ci.test.ts, so the command's `.spec-engine/` dir lands in a tmpdir,
// never inside the committed fixture).
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec CHCK-004 integration

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkCommand } from "../src/commands/check";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURES_ROOT = resolve(import.meta.dir, "fixtures", "diagnostics");
const UNDEFINED_TERM_FIXTURE = join(FIXTURES_ROOT, "undefined-term");
const ORPHAN_TERM_FIXTURE = join(FIXTURES_ROOT, "orphan-term");
const TERM_CLEAN_FIXTURE = join(FIXTURES_ROOT, "term-clean");
// The real repo root (contains spec-engine/) — the self-corpus proof.
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

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

/** Run `spec check --ci` in-process against a CLONE of `fixtureDir` (so the
 *  command's `.spec-engine/` dir lands in a tmpdir, never in the committed
 *  fixture) and return the process.exit code the ExitError stub surfaced. */
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

describe("self-corpus — the real platform after the Wave F GLOSSARY migration", () => {
  test("migrated terms are uncited ORPHAN_TERM WARNINGS; UNDEFINED_TERM stays absent; gate exit 0", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: REPO_ROOT, storage: s });
      const rows = s.listSemanticDiagnostics();
      // No requirement cites a term yet (every `cites` is []), so a citation to
      // an unresolvable term can never fire.
      expect(rows.some((d) => d.code === "UNDEFINED_TERM")).toBe(false);
      // Wave F migrated GLOSSARY.md into TERM-001..N — those Active terms are not
      // cited yet, so ORPHAN_TERM fires for them. It MUST stay warning-severity:
      // an uncited freshly-migrated term is glossary rot to flag, never a
      // build-breaker.
      const orphans = rows.filter((d) => d.code === "ORPHAN_TERM");
      expect(orphans.length).toBeGreaterThan(0);
      expect(orphans.every((d) => d.severity === "warning")).toBe(true);
      // The `spec check --ci` exit contract IS `rows.some(severity === "error")`;
      // the migrated-but-uncited terms are warnings, so the self-gate stays exit 0.
      expect(rows.some((d) => d.severity === "error")).toBe(false);
    } finally {
      s.close();
    }
  });
});
