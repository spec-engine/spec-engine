// packages/engine/test/cli-map-unit.test.ts
//
// Unit tests for `spec map` (commands/map.ts) at the COMMAND layer.
// In-process invocation of the citty command with process.exit stubbed to
// throw ExitError so the runner can assert on exit codes without
// terminating. Mirrors the ExitError / console-capture / mkdtempSync
// pattern from cli-check-unit.test.ts.
//
// Scope (260605-g84):
//   B.1 — indexed-but-empty platform prints an actionable "No requirements
//         indexed" message on stderr (text mode), exit 0; --json still emits
//         "[]" on stdout with NO message.
//   B.2 — missing-platform (no spec-engine/) prints the friendly
//         not-a-platform message (no stack trace) + exit 2.
//
// Storage is exercised through openStorage inside the command — these are
// integration-flavored command tests, not pure-formatter tests (map.test.ts
// owns those). No bun:sqlite import here (D-08): the command owns storage.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapCommand } from "../src/commands/map";

let tmp: string;
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-cli-map-"));
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
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const mapRun = (mapCommand as unknown as { run: RunFn }).run;

/** Run map in-process. Returns the exit code if the command called
 *  process.exit, or -1 if it returned normally (map returns on the empty
 *  text path WITHOUT calling exit — exit 0 is implicit). */
async function runMap(args: Record<string, unknown>): Promise<number> {
  try {
    await mapRun({ args, rawArgs: [] });
    return -1; // returned normally → implicit exit 0
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

/** Indexed-but-empty platform: a canonical spec-engine/ dir with a manifest
 *  but NO SPEC.md → zero requirements → zero coverage rows. */
function makeEmptyPlatform(root: string): void {
  mkdirSync(join(root, "spec-engine"), { recursive: true });
}

describe("spec map — empty coverage matrix (B.1)", () => {
  test("(a) text mode: prints 'No requirements indexed' on stderr, no blank matrix, exit 0", async () => {
    makeEmptyPlatform(tmp);
    const code = await runMap({ platformDir: tmp });
    // Returned normally (no process.exit) → implicit exit 0.
    expect(code).toBe(-1);
    // Actionable message on stderr…
    expect(errs.some((m) => m.includes("No requirements indexed"))).toBe(true);
    expect(errs.some((m) => m.includes(tmp))).toBe(true);
    expect(errs.some((m) => m.includes("spec map fixtures/platform-fixture"))).toBe(true);
    // …and NO blank-matrix stdout. The text path short-circuits before
    // renderMatrix, so console.log was never called.
    expect(logs.length).toBe(0);
  });

  test("(b) --json mode: stdout is exactly '[]' and NO message is emitted", async () => {
    makeEmptyPlatform(tmp);
    const code = await runMap({ platformDir: tmp, json: true });
    expect(code).toBe(-1); // returned normally → exit 0
    // Machine consumers depend on "[]" on stdout.
    const jsonLine = logs.find((l) => l.startsWith("[") || l.startsWith("{"));
    expect(jsonLine).toBe("[]");
    // The B.1 text message MUST NOT appear in --json mode.
    expect(errs.some((m) => m.includes("No requirements indexed"))).toBe(false);
  });
});

describe("spec map — missing platform (B.2)", () => {
  test("(c) no spec-engine/ → friendly message (no stack trace) + exit 2", async () => {
    // tmp is bare — no spec-engine/ → NotASpecPlatformError caught at the
    // command boundary → friendly message + exit 2.
    const code = await runMap({ platformDir: tmp });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("is not a spec-check platform yet"))).toBe(true);
    expect(errs.some((m) => m.includes("spec map fixtures/platform-fixture"))).toBe(true);
    // No leaked internals: neither the old plain-Error prefix nor stack frames.
    expect(errs.some((m) => m.includes("discoverRepos:"))).toBe(false);
    expect(errs.some((m) => /\n\s+at\s/.test(m) || m.includes("    at "))).toBe(false);
  });

  test("(d) non-platform dir leaves NO .spec-engine/ artifact and is idempotent (1st === 2nd run)", async () => {
    // Follow-up fix (260605-g84): assertSpecPlatform runs BEFORE
    // mkdirSync(.spec-engine)/openStorage, so a non-platform dir throws → exit 2
    // and writes NOTHING. Without the fix the 1st run littered an empty
    // index there, and the 2nd run's needsIndex short-circuit found it,
    // read 0 rows, and wrongly printed the B.1 message with exit 0 —
    // re-introducing the stale-empty-index poisoning this task exists to kill.

    // 1st run: friendly B.2 message + exit 2 + NO artifact.
    const first = await runMap({ platformDir: tmp });
    expect(first).toBe(2);
    expect(errs.some((m) => m.includes("is not a spec-check platform yet"))).toBe(true);
    expect(existsSync(join(tmp, ".spec-engine"))).toBe(false);

    // 2nd run against the SAME dir: identical message + identical exit 2
    // (NOT the B.1 "No requirements indexed" + exit 0 the old bug produced),
    // and still NO artifact. Idempotent: 1st === 2nd.
    errs.length = 0;
    logs.length = 0;
    const second = await runMap({ platformDir: tmp });
    expect(second).toBe(2);
    expect(errs.some((m) => m.includes("is not a spec-check platform yet"))).toBe(true);
    // B.2 stays distinct from B.1: the empty-index message must NOT appear.
    expect(errs.some((m) => m.includes("No requirements indexed"))).toBe(false);
    expect(existsSync(join(tmp, ".spec-engine"))).toBe(false);
  });
});

describe("spec map — real empty platform stays B.1, distinct from B.2", () => {
  test("(e) spec-engine/ present but zero requirements → B.1 message + exit 0 (not B.2)", async () => {
    // Guards the regression boundary: assertSpecPlatform only fires when
    // spec-engine/ is ABSENT. A real platform whose spec-engine/ exists but
    // holds no requirements must still reach the indexed-but-empty B.1 path
    // (exit 0), NOT the not-a-platform B.2 path (exit 2).
    makeEmptyPlatform(tmp);
    const code = await runMap({ platformDir: tmp });
    expect(code).toBe(-1); // returned normally → implicit exit 0
    expect(errs.some((m) => m.includes("No requirements indexed"))).toBe(true);
    // B.2 message must NOT appear for a real (if empty) platform.
    expect(errs.some((m) => m.includes("is not a spec-check platform yet"))).toBe(false);
    // A real platform DOES get a derived index (the B.1 path indexes it).
    expect(existsSync(join(tmp, ".spec-engine"))).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// RED-14 dead-end audit: map's V12 --out containment guard existed without a
// covering test (check/gate/serve had theirs; map did not).
// ----------------------------------------------------------------------------

describe("spec map — V12 --out path containment (RED-14)", () => {
  test("--out resolving outside platformDir → exit 2 'must be inside platformDir'", async () => {
    makeEmptyPlatform(tmp);
    const code = await runMap({ platformDir: tmp, out: join(tmp, "..", "evil.sqlite") });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/must be inside platformDir/);
    // The guard fires BEFORE any FS write — no stray .spec-engine/ artifact.
    expect(existsSync(join(tmp, ".spec-engine"))).toBe(false);
  });
});
