// packages/engine/test/cli-prompt.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INIT-008
//
// INIT-13: helper-level tests for the shared interactive onboarding prompt
// (packages/engine/src/onboarding/prompt.ts — Plan 10-01 Task 2 GREEN
// ships the helper; Plan 10-02 Task 2 extends this file with the 8×4
// command-fanout matrix + 2 grep-invariant tests + 1 Pitfall 6 edge case).
//
// In-process invocation of `maybePromptForOnboarding` with `process.exit`
// stubbed to throw `ExitError` so the test runner can assert on the
// numeric exit code without terminating mid-suite (mirrors verbatim from
// cli-init.test.ts:39-79 / cli-new.test.ts:30-34).
//
// Coverage map (10 describe blocks, 43 tests):
//   Plan 10-01 (8 helper-level tests, 1 describe):
//   - 4 interactive paths against the maybePromptForOnboarding helper:
//       1. y → inline initCommand.run writes spec-engine.member.json + return
//       2. n → stderr message + process.exit(1)
//       3. empty input → same as n
//       4. "  Y  " → trim+toLowerCase advances (success path)
//   - 3 suppression paths:
//       5. !process.stdin.isTTY → return cleanly
//       6. args.ci === true     → return cleanly
//       7. args.noPrompt === true → return cleanly
//   - 1 empty-skipped short-circuit:
//       8. skipped[] empty under TTY → return without prompting
//
//   Plan 10-02 (35 tests, 9 describes):
//   - 8 INDEXING_COMMANDS × 4 paths = 32 matrix tests covering each
//     indexing-tier command's (index, check, map, propagation, query,
//     resolve, gate, serve) integration with the helper:
//       interactive y → spec-engine.member.json written
//       interactive n → exit 1 + no file + documented stderr
//       non-interactive (no TTY) → suppress + Phase 8 fall-through
//       --no-prompt → suppress + Phase 8 fall-through
//   - 1 "shared prompt helper consumed by all 8" describe (2 grep tests)
//     enforces the success-criterion #4 invariant via source grep
//   - 1 "Pitfall 6 lock" describe (1 grep test) enforces that the helper
//     does NOT try/catch around initRun — init's exit-2 propagates
//
// Pitfall 3 lock: `process.stdin.isTTY` is saved in beforeEach and
// restored in afterEach (Object.defineProperty with configurable: true).
//
// Pitfall 5 lock: runHelper passes ONLY `{ ci, noPrompt }` — never spreads
// extra args. The helper's surface intentionally narrow.
//
// Pitfall 6 lock (Plan 10-02): the helper does NOT swallow initCommand.run
// failures. The matrix verifies via grep instead of bun:test mock.module
// (which is fragile across module re-import) — the grep gate counts
// `try {` occurrences in prompt.ts and asserts ≤ 1 (askYesNo's finally
// has exactly one; the main maybePromptForOnboarding function has zero).
//
// Storage-free: this file imports zero from `bun:sqlite` — D-08 grep-fence
// stays at exactly 1 src-side `bun:sqlite` import system-wide.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommand } from "../src/commands/check";
import { gateCommand } from "../src/commands/gate";
import { indexCommand } from "../src/commands/index";
import { mapCommand } from "../src/commands/map";
import { propagationCommand } from "../src/commands/propagation";
import { queryCommand } from "../src/commands/query";
import { resolveCommand } from "../src/commands/resolve";
import { serveCommand } from "../src/commands/serve";
import { maybePromptForOnboarding } from "../src/onboarding/prompt";

let tmp: string;
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;
let originalIsTTY: boolean | undefined;
// Plan 10-02: Bun.serve save/restore for the serve matrix cells. The
// real-serve branch of serveCommand calls Bun.serve at the end of its
// run() — without a stub the matrix's "interactive y" / "non-interactive"
// / "--no-prompt" serve cells would leak a bound port for the lifetime
// of the test process. Restored in afterEach so unrelated tests (e.g.
// the serve-loopback file run in a sibling process) are unaffected.
let originalBunServe: typeof Bun.serve;

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-cli-prompt-"));
  logs = [];
  errs = [];
  originalLog = console.log;
  originalErr = console.error;
  originalExit = process.exit;
  originalIsTTY = process.stdin.isTTY;
  originalBunServe = Bun.serve;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new ExitError(code ?? 0);
  };
  // Plan 10-02: stub Bun.serve so serve matrix cells don't leak a bound
  // port. Returns the minimal shape serve.ts reads (`.port`) and a no-op
  // `stop()` so probe-style members can still call stop without TypeError.
  (Bun as unknown as { serve: (opts: unknown) => unknown }).serve = (_opts: unknown) => ({
    port: 0,
    stop: () => {},
    fetch: async () => new Response("stub", { status: 200 }),
    hostname: "127.0.0.1",
    pendingRequests: 0,
    pendingWebSockets: 0,
    development: false,
    url: new URL("http://127.0.0.1:0"),
    upgrade: () => false,
    publish: () => 0,
    reload: () => {},
    ref: () => {},
    unref: () => {},
    requestIP: () => null,
    timeout: () => {},
    [Symbol.dispose]: () => {},
    [Symbol.asyncDispose]: async () => {},
    id: "stub",
    subscriberCount: () => 0,
  });
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  (Bun as unknown as { serve: typeof Bun.serve }).serve = originalBunServe;
  // WR-02: reset `mock.module("node:readline", ...)` stamped by
  // mockReadlineAnswer. Bun's mock.module mutates the module-resolution
  // cache for the process lifetime — without an explicit restore the
  // last test's stub persists across tests in this file AND leaks into
  // sibling test files via the shared module cache. `mock.restore()`
  // resets ALL mock.module + spy state set during the test (per Bun
  // docs); harmless when no mock was set.
  mock.restore();
  rmSync(tmp, { recursive: true, force: true });
});

/** Build a tmp platform with one member slot + one skipped sibling.
 *  Verbatim shape from cli-check-unit.test.ts:141-146 makeWarningOnlyFixture,
 *  renamed for clarity. Produces ONE entry in discoverRepos.skipped[]. */
function makeFixtureWithSkipped(root: string): { stranger: string } {
  mkdirSync(join(root, "spec-engine"), { recursive: true });
  mkdirSync(join(root, "strangers"), { recursive: true });
  // RUNG1-02: `strangers/` must carry a repo-root marker (.git/package.json)
  // to be classified as a SKIPPED sibling — a real unwired member repo that
  // drives the onboarding prompt / NO_SPEC_CONFIG. A bare folder with no
  // marker is a bucket-3 plain folder, ignored from sibling enumeration.
  writeFileSync(join(root, "strangers", "package.json"), JSON.stringify({ name: "strangers" }));
  return { stranger: join(root, "strangers") };
}

/** Override process.stdin.isTTY via property descriptor (Pitfall 3 — global
 *  state; the originalIsTTY save in beforeEach + restore in afterEach is
 *  what makes mutating this global safe across tests). */
function setIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

/** Stub node:readline so createInterface returns a fake rl whose `question`
 *  immediately invokes the callback with `answer` (Pattern 5 / Approach A).
 *  First use site of bun:test mock.module in the codebase. */
function mockReadlineAnswer(answer: string): void {
  mock.module("node:readline", () => ({
    createInterface: () => ({
      question: (_q: string, cb: (a: string) => void) => cb(answer),
      close: () => {},
    }),
  }));
}

/** Numeric-return helper for the INIT-13 exit-code matrix. Returns 0 when
 *  maybePromptForOnboarding returns cleanly, the captured exit code on
 *  ExitError, rethrows otherwise. Pitfall 5: pass ONLY `{ ci, noPrompt }`. */
async function runHelper(args: { ci?: boolean; noPrompt?: boolean }): Promise<number> {
  try {
    await maybePromptForOnboarding({
      platformDir: tmp,
      args: { ci: args.ci, noPrompt: args.noPrompt },
    });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

describe("INIT-13: maybePromptForOnboarding helper", () => {
  test("interactive y path writes spec-engine.member.json + returns cleanly", async () => {
    setIsTTY(true);
    mockReadlineAnswer("y");
    makeFixtureWithSkipped(tmp);

    const code = await runHelper({ ci: false, noPrompt: false });

    expect(code).toBe(0);
    expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(true);
    const written = readFileSync(join(tmp, "strangers", "spec-engine.member.json"), "utf-8");
    expect(written.includes("spec-engine@")).toBe(true);
  });

  test("interactive n path prints stderr + exits 1 (no file written)", async () => {
    setIsTTY(true);
    mockReadlineAnswer("n");
    makeFixtureWithSkipped(tmp);

    const code = await runHelper({ ci: false, noPrompt: false });

    expect(code).toBe(1);
    expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(false);
    expect(errs.some((l) => l.includes("spec: strangers/ has no spec-engine.member.json"))).toBe(
      true,
    );
    expect(errs.some((l) => l.includes("run `spec init strangers` first"))).toBe(true);
    expect(errs.some((l) => l.includes("re-run non-interactively to skip with a warning"))).toBe(
      true,
    );
  });

  test("interactive empty-input path exits 1 (same as n)", async () => {
    setIsTTY(true);
    mockReadlineAnswer("");
    makeFixtureWithSkipped(tmp);

    const code = await runHelper({ ci: false, noPrompt: false });

    expect(code).toBe(1);
    expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(false);
  });

  test("interactive whitespace `  Y  ` path advances (trim+toLowerCase boundary)", async () => {
    setIsTTY(true);
    mockReadlineAnswer("  Y  ");
    makeFixtureWithSkipped(tmp);

    const code = await runHelper({ ci: false, noPrompt: false });

    expect(code).toBe(0);
    expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(true);
  });

  test("non-interactive (isTTY undefined) suppresses — no file written, no stderr", async () => {
    setIsTTY(undefined);
    makeFixtureWithSkipped(tmp);

    const code = await runHelper({ ci: false, noPrompt: false });

    expect(code).toBe(0);
    expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(false);
    expect(errs).toHaveLength(0);
  });

  test("--ci suppression (TTY true but ci flag set) returns cleanly", async () => {
    setIsTTY(true);
    makeFixtureWithSkipped(tmp);

    const code = await runHelper({ ci: true, noPrompt: false });

    expect(code).toBe(0);
    expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(false);
    expect(errs).toHaveLength(0);
  });

  test("--no-prompt suppression (TTY true but noPrompt flag set) returns cleanly", async () => {
    setIsTTY(true);
    makeFixtureWithSkipped(tmp);

    const code = await runHelper({ ci: false, noPrompt: true });

    expect(code).toBe(0);
    expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(false);
    expect(errs).toHaveLength(0);
  });

  test("empty skipped[] under interactive path returns cleanly without prompting", async () => {
    setIsTTY(true);
    // Fixture with ONLY spec-engine/ — no strangers/ dir → discoverRepos returns skipped: [].
    mkdirSync(join(tmp, "spec-engine"), { recursive: true });

    const code = await runHelper({ ci: false, noPrompt: false });

    expect(code).toBe(0);
    expect(errs).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Plan 10-02: 8 × 4 command-fanout matrix
// ----------------------------------------------------------------------------
//
// Parameterized over INDEXING_COMMANDS — each command's (index, check, map,
// propagation, query, resolve, gate, serve) integration with the helper is
// tested across the four documented paths:
//
//   interactive y → spec-engine.member.json written for the skipped sibling
//   interactive n → exit 1 + no file written + documented stderr message
//   non-interactive (no TTY) → suppress + Phase 8 NO_SPEC_CONFIG fall-through
//   --no-prompt → suppress + Phase 8 NO_SPEC_CONFIG fall-through
//
// Pitfall 7 lock: the "interactive y" cell's load-bearing assertion is
// `expect(existsSync(...config.json)).toBe(true)` — without it, a future
// regression where the helper just returns without invoking initRun would
// still pass this test. File-existence is the contract under test.
//
// Pitfall 8 lock for gate + serve: the "interactive n" cells exit 1 BEFORE
// any destructive FS work (gate's cold-rm trio; serve's mkdirSync + Bun.serve
// bind). The test framework's default 5s timeout is the hang regression
// signal — no explicit timeout assertions needed.
//
// extraArgs per command carry the required positionals each command needs:
//   propagation needs reqId, query needs text, resolve needs files,
//   gate needs repo+reqId, serve needs port.

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;

/** Numeric-return helper for the matrix cells. Returns 0 when the command's
 *  run() returns cleanly, the captured exit code on ExitError, rethrows on
 *  any other throw. Matches `runHelper` shape from the helper-level block. */
async function runCommand(
  cmd: { run: RunFn } | unknown,
  args: Record<string, unknown>,
): Promise<number> {
  try {
    await (cmd as { run: RunFn }).run({ args, rawArgs: [] });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

const INDEXING_COMMANDS = [
  { name: "index", cmd: indexCommand, extraArgs: {} as Record<string, unknown> },
  { name: "check", cmd: checkCommand, extraArgs: {} as Record<string, unknown> },
  { name: "map", cmd: mapCommand, extraArgs: {} as Record<string, unknown> },
  {
    name: "propagation",
    cmd: propagationCommand,
    extraArgs: { reqId: "BILLING-001" } as Record<string, unknown>,
  },
  { name: "query", cmd: queryCommand, extraArgs: { text: "x" } as Record<string, unknown> },
  {
    name: "resolve",
    cmd: resolveCommand,
    extraArgs: { files: "api/src/x.ts" } as Record<string, unknown>,
  },
  {
    name: "gate",
    cmd: gateCommand,
    extraArgs: { repo: "api", reqId: "BILLING-001" } as Record<string, unknown>,
  },
  { name: "serve", cmd: serveCommand, extraArgs: { port: "0" } as Record<string, unknown> },
];

for (const { name, cmd, extraArgs } of INDEXING_COMMANDS) {
  describe(`INIT-13 (${name})`, () => {
    test("interactive y writes config + continues", async () => {
      setIsTTY(true);
      mockReadlineAnswer("y");
      makeFixtureWithSkipped(tmp);

      // We intentionally do NOT assert on the exit code value — different
      // commands exit differently after the prompt returns successfully
      // (gate exits 2 on unknown-repo lookup with the minimal fixture;
      // check may exit 1 on diagnostics; serve returns cleanly via the
      // Bun.serve stub). The file-existence assertion (Pitfall 7) is the
      // primary contract under test: y → init writes spec-engine.member.json
      // for the sibling.
      await runCommand(cmd, { platformDir: tmp, ...extraArgs });
      expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(true);
      // WR-03: lock the negative contract — the INIT-13 stderr message
      // ("spec: strangers/ has no spec-engine.member.json") is the proxy for
      // "prompt fired exit 1." Since per-command exit codes vary, we
      // assert the ABSENCE of that message instead. This catches three
      // regression channels that the file-existence check alone misses:
      //   (1) helper writes the config but STILL hits the exit-1 path
      //       (e.g., a `continue` becomes a fall-through)
      //   (2) helper double-prompts the same sibling (the second prompt
      //       on a now-onboarded entry would re-fire the stderr)
      //   (3) helper swallows initRun's exit-2 and falls through to the
      //       exit-1 print (Pitfall 6 — also locked by the grep test
      //       below, but a behavioural lock is safer)
      expect(errs.some((l) => l.includes("spec: strangers/ has no spec-engine.member.json"))).toBe(
        false,
      );
    });

    test("interactive n exits 1 with documented message", async () => {
      setIsTTY(true);
      mockReadlineAnswer("n");
      makeFixtureWithSkipped(tmp);

      const code = await runCommand(cmd, { platformDir: tmp, ...extraArgs });

      expect(code).toBe(1);
      // Exit 1 fired BEFORE mkdirSync(.spec-engine) → no artefacts left behind.
      // For gate, also BEFORE the unconditional cold-rm trio (Pitfall 8).
      // For serve, the stubbed Bun.serve was never reached.
      expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(false);
      expect(errs.some((l) => l.includes("spec: strangers/ has no spec-engine.member.json"))).toBe(
        true,
      );
    });

    test("non-interactive (no TTY) suppresses + falls through", async () => {
      setIsTTY(undefined);
      makeFixtureWithSkipped(tmp);

      await runCommand(cmd, { platformDir: tmp, ...extraArgs });

      // Suppression path: prompt never fires → no spec-engine.member.json
      // written for the skipped sibling. The Phase 8 NO_SPEC_CONFIG
      // warning still fires from the pipeline downstream (when a
      // command runs runIndex) — verified for `check` in
      // cli-check-unit.test.ts. Here we only lock the suppression
      // signal: the prompt did NOT fire under !isTTY.
      expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(false);
      expect(errs.some((l) => l.includes("spec: strangers/ has no spec-engine.member.json"))).toBe(
        false,
      );
    });

    test("--no-prompt suppresses + falls through", async () => {
      setIsTTY(true);
      makeFixtureWithSkipped(tmp);

      await runCommand(cmd, { platformDir: tmp, noPrompt: true, ...extraArgs });

      // Same suppression contract as the no-TTY cell — flag overrides
      // TTY presence. Phase 8 NO_SPEC_CONFIG fall-through is preserved
      // (see cli-check-unit.test.ts for the --json stdout assertion).
      expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(false);
      expect(errs.some((l) => l.includes("spec: strangers/ has no spec-engine.member.json"))).toBe(
        false,
      );
    });
  });
}

// ----------------------------------------------------------------------------
// Plan 10-02: shared-helper invariant (success criterion #4)
// ----------------------------------------------------------------------------
//
// Grep over source to enforce that all 8 indexing-tier commands consume
// the SAME helper (no forked logic). Locks the spec's fanout invariant
// at the source layer — a future plan that adds a 9th indexing command
// will trip this if it doesn't wire the helper.

describe("INIT-13: shared prompt helper consumed by all 8 indexing-tier commands", () => {
  const COMMANDS = ["index", "check", "map", "propagation", "query", "resolve", "gate", "serve"];

  test("all 8 commands import maybePromptForOnboarding from onboarding/prompt", () => {
    for (const cmdName of COMMANDS) {
      const src = readFileSync(`packages/engine/src/commands/${cmdName}.ts`, "utf-8");
      expect(src.includes("maybePromptForOnboarding")).toBe(true);
      expect(src.includes('from "../onboarding/prompt"')).toBe(true);
    }
  });

  test("all 8 commands register the noPrompt arg", () => {
    for (const cmdName of COMMANDS) {
      const src = readFileSync(`packages/engine/src/commands/${cmdName}.ts`, "utf-8");
      expect(src.includes("noPrompt:")).toBe(true);
    }
  });
});

// ----------------------------------------------------------------------------
// Plan 10-02: Pitfall 6 lock — helper does NOT catch initRun's exit
// ----------------------------------------------------------------------------
//
// The plan documents two strategies for this lock: mock.module-based or
// grep-based. The grep approach is chosen (per plan REVISED note) because
// it's the safer fallback — Bun's `mock.module` cache + dynamic-import
// re-evaluation is fragile across the matrix's per-test mock stack.
//
// Invariant: prompt.ts contains ZERO `try {` blocks around the
// `await initRun(...)` call. A future change that adds try/catch around
// initRun would silently swallow init's process.exit(2) failure paths,
// masking real errors.
//
// WR-04: the original `count(/try\s*\{/) <= 1` check was brittle for two
// reasons:
//
//   (a) False positive: any future refactor that wraps something else in
//       try/catch (e.g., tagging a discoverRepos error) would trip the
//       count even though it doesn't violate Pitfall 6.
//   (b) False negative: a move to TC39 `using` resource management would
//       REMOVE askYesNo's existing try/finally — dropping the count to 0
//       — and a later engineer could then wrap `await initRun(...)` in
//       try/catch without tripping the count.
//
// Replaced with two targeted locks that match the actual hazard:
//   Regex: no `try { ... await initRun(` window within the file
//   (sticky-match using a window of bytes, not raw `try {` counting).

describe("INIT-13: inline init propagates exit-2 on path-safety refusal", () => {
  test("prompt.ts has no try/catch around initRun (Pitfall 6 — regex)", () => {
    const src = readFileSync("packages/engine/src/onboarding/prompt.ts", "utf-8");
    // Match any `try {` followed (on any lines, possibly with whitespace
    // and code in between but NO closing `}` first) by `await initRun(`.
    // The negated character class `[^}]*` ensures we don't cross a block
    // boundary. The `s` flag lets `.` match newlines if we later need it
    // — kept on for forward compatibility with multi-line refactors.
    const tryAroundInitRun = /try\s*\{[^}]*await\s+initRun\s*\(/s;
    expect(tryAroundInitRun.test(src)).toBe(false);
  });
});
