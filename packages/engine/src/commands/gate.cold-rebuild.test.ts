import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { listRepoNamesFromDb, poisonRepoRow } from "../storage/sqlite";
import { cloneFixture } from "../testing/cloneFixture";
import { entryOf, plantEdit } from "../testing/plant";
import { gateCommand } from "./gate";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let dbPath: string;
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
  clone = cloneFixture(FIXTURE);
  dbPath = join(clone, ".spec-engine", "index.sqlite");
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
  try {
    rmSync(clone, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const gateRun = (gateCommand as unknown as { run: RunFn }).run;

async function runGate(args: Record<string, unknown>): Promise<number> {
  try {
    await gateRun({ args, rawArgs: [] });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

function lastLogAsJson<T = Record<string, unknown>>(): T {
  const last = logs.at(-1) ?? "";
  return JSON.parse(last) as T;
}

describe("spec gate cold-rebuild invariant", () => {
  test("CR1: spec mutation observed without manual reindex (Active → DRAFT)", async () => {
    const code1 = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code1).toBe(0);
    const out1 = lastLogAsJson<{ reason: string }>();
    const reason1 = out1.reason;
    expect(reason1).toBe("PASS");

    await plantEdit(clone, "BILLING", (spec) => {
      const b9 = entryOf(spec, "BILLING-009");
      expect(b9.status).toBe("active");
      b9.status = "draft";
    });

    logs.length = 0;
    errs.length = 0;

    const code2 = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code2).toBe(1);
    const out2 = lastLogAsJson<{ reason: string }>();
    const reason2 = out2.reason;
    expect(reason2).toBe("DRAFT");

    expect(reason1).not.toBe(reason2);
  });

  test("CR2: pre-poisoned DB row is wiped before classifier reads", async () => {
    // A surviving poison row would resolve as a repo and route gate into
    // classifyGate (exit 0 or 1), so exit 2 "unknown repo" proves the wipe.
    const code0 = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code0).toBe(0);

    poisonRepoRow(dbPath, "poisoned-ghost-repo");

    const namesAfterPoison = listRepoNamesFromDb(dbPath);
    expect(namesAfterPoison).toContain("poisoned-ghost-repo");

    logs.length = 0;
    errs.length = 0;

    const code1 = await runGate({
      repo: "poisoned-ghost-repo",
      reqId: "BILLING-009",
      platformDir: clone,
    });
    expect(code1).toBe(2);
    expect(errs.join("\n")).toContain("unknown repo");

    const namesAfterGate = listRepoNamesFromDb(dbPath);
    expect(namesAfterGate).not.toContain("poisoned-ghost-repo");
  });
});
