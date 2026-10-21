import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapCommand } from "./map";

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

/** -1 when map returned without calling process.exit: an implicit exit 0. */
async function runMap(args: Record<string, unknown>): Promise<number> {
  try {
    await mapRun({ args, rawArgs: [] });
    return -1;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

function makeEmptyPlatform(root: string): void {
  mkdirSync(join(root, "spec-engine"), { recursive: true });
}

describe("spec map — empty coverage matrix", () => {
  test("text mode: prints 'No requirements indexed' on stderr, no blank matrix, exit 0", async () => {
    makeEmptyPlatform(tmp);
    const code = await runMap({ platformDir: tmp });
    expect(code).toBe(-1);
    expect(errs.some((m) => m.includes("No requirements indexed"))).toBe(true);
    expect(errs.some((m) => m.includes(tmp))).toBe(true);
    expect(errs.some((m) => m.includes("spec map fixtures/platform-fixture"))).toBe(true);
    expect(logs.length).toBe(0);
  });

  test("--json mode: stdout is exactly '[]' and NO message is emitted", async () => {
    makeEmptyPlatform(tmp);
    const code = await runMap({ platformDir: tmp, json: true });
    expect(code).toBe(-1);
    const jsonLine = logs.find((l) => l.startsWith("[") || l.startsWith("{"));
    expect(jsonLine).toBe("[]");
    expect(errs.some((m) => m.includes("No requirements indexed"))).toBe(false);
  });
});

describe("spec map — missing platform", () => {
  test("no spec-engine/ → friendly message (no stack trace) + exit 2", async () => {
    const code = await runMap({ platformDir: tmp });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(true);
    expect(errs.some((m) => m.includes("spec map fixtures/platform-fixture"))).toBe(true);
    expect(errs.some((m) => m.includes("discoverRepos:"))).toBe(false);
    expect(errs.some((m) => /\n\s+at\s/.test(m) || m.includes("    at "))).toBe(false);
  });

  test("non-platform dir leaves NO .spec-engine/ artifact and is idempotent (1st === 2nd run)", async () => {
    // An empty index left by the first run would make the second run's
    // needsIndex short-circuit read 0 rows and report an empty platform.
    const first = await runMap({ platformDir: tmp });
    expect(first).toBe(2);
    expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(true);
    expect(existsSync(join(tmp, ".spec-engine"))).toBe(false);

    errs.length = 0;
    logs.length = 0;
    const second = await runMap({ platformDir: tmp });
    expect(second).toBe(2);
    expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(true);
    expect(errs.some((m) => m.includes("No requirements indexed"))).toBe(false);
    expect(existsSync(join(tmp, ".spec-engine"))).toBe(false);
  });
});

describe("spec map — a real empty platform is not a missing platform", () => {
  test("spec-engine/ present but zero requirements → empty-index message + exit 0, not the not-a-platform message", async () => {
    makeEmptyPlatform(tmp);
    const code = await runMap({ platformDir: tmp });
    expect(code).toBe(-1);
    expect(errs.some((m) => m.includes("No requirements indexed"))).toBe(true);
    expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(false);
    expect(existsSync(join(tmp, ".spec-engine"))).toBe(true);
  });
});

describe("spec map — --out path containment", () => {
  test("--out resolving outside platformDir → exit 2 'must be inside platformDir'", async () => {
    makeEmptyPlatform(tmp);
    const code = await runMap({ platformDir: tmp, out: join(tmp, "..", "evil.sqlite") });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/must be inside platformDir/);
    expect(existsSync(join(tmp, ".spec-engine"))).toBe(false);
  });
});
