// @spec INIT-060
//
// `process.exit` is stubbed to throw ExitError so a test can assert the exit
// code without terminating the suite.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommand } from "../commands/check";
import { gateCommand } from "../commands/gate";
import { indexCommand } from "../commands/index";
import { mapCommand } from "../commands/map";
import { propagationCommand } from "../commands/propagation";
import { queryCommand } from "../commands/query";
import { resolveCommand } from "../commands/resolve";
import { serveCommand } from "../commands/serve";
import { TestPlatform } from "../testing/platform";
import { maybePromptForOnboarding } from "./prompt";

let tmp: string;
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;
let originalIsTTY: boolean | undefined;
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
  // serveCommand ends by calling Bun.serve; unstubbed, every serve cell in
  // the matrix would leak a bound port for the life of the test process.
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
  // Bun's mock.module mutates the module cache for the process lifetime:
  // without this restore the last readline stub leaks into later tests and
  // sibling test files.
  mock.restore();
  rmSync(tmp, { recursive: true, force: true });
});

/** A platform with one declared member that has no pin: the one entry in discoverRepos().unpinned. */
function makeFixtureWithSkipped(root: string): { stranger: string } {
  return { stranger: TestPlatform.at(root).unpinned("strangers").dir };
}

/** A platform with one declared member and one repository nobody declared: the one entry in discoverRepos().undeclared. */
async function makeFixtureWithUndeclared(root: string): Promise<{ stranger: string }> {
  const fx = TestPlatform.at(root);
  await fx.member("api");
  return { stranger: fx.repository("strangers").dir };
}

/** Global state: safe only because afterEach restores the saved originalIsTTY. */
function setIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

function mockReadlineAnswer(answer: string): void {
  mock.module("node:readline", () => ({
    createInterface: () => ({
      question: (_q: string, cb: (a: string) => void) => cb(answer),
      close: () => {},
    }),
  }));
}

/** 0 on a clean return, the exit code on ExitError. Passes only `{ ci,
 *  noPrompt }`, never spread args, so the helper's surface stays narrow. */
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

describe("maybePromptForOnboarding helper", () => {
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

  test("nothing to offer under the interactive path returns cleanly without prompting", async () => {
    setIsTTY(true);
    TestPlatform.at(tmp);

    const code = await runHelper({ ci: false, noPrompt: false });

    expect(code).toBe(0);
    expect(errs).toHaveLength(0);
  });
});

describe("the prompt offers spec init for an undeclared repository in the platform folder", () => {
  test("y declares the repository (platform file entry + marker) and writes its pin", async () => {
    setIsTTY(true);
    mockReadlineAnswer("y");
    await makeFixtureWithUndeclared(tmp);

    const code = await runHelper({ ci: false, noPrompt: false });

    expect(code).toBe(0);
    expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(true);
    expect(existsSync(join(tmp, "strangers", "platform-map.json"))).toBe(true);
    const platformFile = JSON.parse(readFileSync(join(tmp, "platform-map.json"), "utf-8"));
    expect(platformFile.members).toEqual(["api", "strangers"]);
  });

  test("n exits 1 naming the repository and spec init <name>", async () => {
    setIsTTY(true);
    mockReadlineAnswer("n");
    await makeFixtureWithUndeclared(tmp);

    const code = await runHelper({ ci: false, noPrompt: false });

    expect(code).toBe(1);
    expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(false);
    expect(errs.some((l) => l.includes("spec: strangers/ is not a member of the platform"))).toBe(
      true,
    );
    expect(errs.some((l) => l.includes("run `spec init strangers` first"))).toBe(true);
  });

  test("a declared member is never offered", async () => {
    setIsTTY(true);
    await TestPlatform.at(tmp).member("api");

    const code = await runHelper({ ci: false, noPrompt: false });

    expect(code).toBe(0);
    expect(errs).toHaveLength(0);
  });
});

// A hang in a gate or serve "interactive n" cell surfaces as the runner's
// default 5s timeout; there is no explicit timeout assertion.

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;

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
  describe(`onboarding prompt (${name})`, () => {
    test("interactive y writes config + continues", async () => {
      setIsTTY(true);
      mockReadlineAnswer("y");
      makeFixtureWithSkipped(tmp);

      // The exit code is not asserted: after the prompt each command exits
      // its own way (gate 2 on the unknown repo, check 1 on diagnostics).
      // The absent stderr line stands in for "the exit-1 path did not fire".
      await runCommand(cmd, { platformDir: tmp, ...extraArgs });
      expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(true);
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
      expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(false);
      expect(errs.some((l) => l.includes("spec: strangers/ has no spec-engine.member.json"))).toBe(
        true,
      );
    });

    test("non-interactive (no TTY) suppresses + falls through", async () => {
      setIsTTY(undefined);
      makeFixtureWithSkipped(tmp);

      await runCommand(cmd, { platformDir: tmp, ...extraArgs });

      expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(false);
      expect(errs.some((l) => l.includes("spec: strangers/ has no spec-engine.member.json"))).toBe(
        false,
      );
    });

    test("--no-prompt suppresses + falls through", async () => {
      setIsTTY(true);
      makeFixtureWithSkipped(tmp);

      await runCommand(cmd, { platformDir: tmp, noPrompt: true, ...extraArgs });

      expect(existsSync(join(tmp, "strangers", "spec-engine.member.json"))).toBe(false);
      expect(errs.some((l) => l.includes("spec: strangers/ has no spec-engine.member.json"))).toBe(
        false,
      );
    });
  });
}

describe("shared prompt helper consumed by all 8 indexing-tier commands", () => {
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

// A try around initRun would swallow init's process.exit(2) refusals. This is
// a source grep rather than a mock.module test because Bun's module cache is
// fragile across the matrix's per-test mock stack.
describe("inline init is never wrapped in a try", () => {
  test("prompt.ts has no try block enclosing await initRun", () => {
    const src = readFileSync("packages/engine/src/onboarding/prompt.ts", "utf-8");
    // `[^}]*` keeps the match from crossing a block boundary.
    const tryAroundInitRun = /try\s*\{[^}]*await\s+initRun\s*\(/s;
    expect(tryAroundInitRun.test(src)).toBe(false);
  });
});
