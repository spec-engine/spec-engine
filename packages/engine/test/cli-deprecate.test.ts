// packages/engine/test/cli-deprecate.test.ts
//
// `spec deprecate <KEY-NNN> --reason "..."` (D1) — the end-of-life command.
// A requirement is never deleted; this flips it to deprecated and records
// WHY on the entry itself (a comment was the wrong record: it lives in the
// code being deleted). Emits the cleanup worklist of tags still on the id.
//
// Verifies:
// @spec REQ-021 unit

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { deprecateCommand } from "../src/commands/deprecate";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

let platformDir: string;
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

beforeEach(() => {
  platformDir = cloneFixture(FIXTURE);
  logs = [];
  errs = [];
  originalLog = console.log;
  originalErr = console.error;
  originalExit = process.exit;
  console.log = (...a: unknown[]) => {
    logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  };
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new ExitError(code ?? 0);
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  rmSync(platformDir, { recursive: true, force: true });
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const run = (deprecateCommand as unknown as { run: RunFn }).run;

function readBilling(): { requirements: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(platformDir, "spec-engine", "BILLING", "SPEC.json"), "utf8"));
}

async function expectExit(code: number, fn: () => Promise<void>): Promise<void> {
  let caught: ExitError | null = null;
  try {
    await fn();
  } catch (e) {
    if (e instanceof ExitError) caught = e;
    else throw e;
  }
  expect(caught?.code).toBe(code);
}

describe("spec deprecate — the end-of-life command (REQ-021)", () => {
  test("an Active requirement deprecates: status + reason on disk, bound tags listed", async () => {
    // BILLING-002 is Active and implemented in api/src.
    await run({
      args: {
        id: "BILLING-002",
        platformDir,
        reason: "feature removed from the product",
        json: true,
      },
      rawArgs: [],
    });
    const out = JSON.parse(logs[logs.length - 1] ?? "{}");
    expect(out.id).toBe("BILLING-002");
    expect(out.reason).toBe("feature removed from the product");
    // The cleanup worklist: the api/src tag still binds the id.
    expect(out.sites.length).toBeGreaterThan(0);
    expect(out.sites[0].repo).toBe("api");

    const onDisk = readBilling().requirements.find((r) => r.id === "BILLING-002");
    expect(onDisk?.status).toBe("deprecated");
    expect(onDisk?.deprecatedReason).toBe("feature removed from the product");
  });

  test("no --reason refuses (exit 2): the reason is the durable record", async () => {
    const before = readFileSync(join(platformDir, "spec-engine", "BILLING", "SPEC.json"), "utf8");
    await expectExit(2, () => run({ args: { id: "BILLING-002", platformDir }, rawArgs: [] }));
    expect(errs.join("\n")).toContain("--reason is required");
    expect(readFileSync(join(platformDir, "spec-engine", "BILLING", "SPEC.json"), "utf8")).toBe(
      before,
    );
  });

  test("a Superseded entry refuses (exit 2) — it is already history", async () => {
    await expectExit(2, () =>
      run({ args: { id: "BILLING-001", platformDir, reason: "x" }, rawArgs: [] }),
    );
    expect(errs.join("\n")).toContain("already history");
  });

  test("deprecating twice refuses (exit 2)", async () => {
    await run({
      args: { id: "BILLING-002", platformDir, reason: "first", json: true },
      rawArgs: [],
    });
    await expectExit(2, () =>
      run({ args: { id: "BILLING-002", platformDir, reason: "second" }, rawArgs: [] }),
    );
    expect(errs.join("\n")).toContain("already deprecated");
  });

  test("an unknown id refuses (exit 2)", async () => {
    await expectExit(2, () =>
      run({ args: { id: "BILLING-999", platformDir, reason: "x" }, rawArgs: [] }),
    );
  });
});
