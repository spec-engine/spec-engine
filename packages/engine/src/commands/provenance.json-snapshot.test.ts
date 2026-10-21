import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { cloneFixture } from "../testing/cloneFixture";
import { provenanceCommand } from "./provenance";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let logs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  // A clone, so the indexer's .spec-engine/ writes land outside the
  // canonical fixtures/platform-fixture/ tree.
  clone = cloneFixture(FIXTURE);
  logs = [];
  originalLog = console.log;
  originalErr = console.error;
  originalExit = process.exit;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = () => {
    // Silence schema-rebuild stderr chatter; tests assert on stdout.
  };
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new ExitError(code ?? 0);
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  rmSync(clone, { recursive: true, force: true });
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const provenanceRun = (provenanceCommand as unknown as { run: RunFn }).run;

async function runProvenance(args: Record<string, unknown>): Promise<number> {
  try {
    await provenanceRun({ args, rawArgs: [] });
    return 0; // provenance command does not call process.exit on success
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

describe("spec provenance --json against canonical platform-fixture", () => {
  test("A: full matrix is byte-identical across two cold rebuilds", async () => {
    await runProvenance({ platformDir: clone, json: true });
    const outA = logs[0] ?? "";
    logs.length = 0;
    rmSync(clone, { recursive: true, force: true });
    clone = cloneFixture(FIXTURE);
    await runProvenance({ platformDir: clone, json: true });
    const outB = logs[0] ?? "";

    expect(outA).toBe(outB);
    expect(outA.length).toBeGreaterThan(2); // not just "[]"
  });

  test("B: reverse lookup ENG-1432 is byte-identical across two cold rebuilds, length >= 1", async () => {
    await runProvenance({ issueId: "ENG-1432", platformDir: clone, json: true });
    const outA = logs[0] ?? "";
    logs.length = 0;
    rmSync(clone, { recursive: true, force: true });
    clone = cloneFixture(FIXTURE);
    await runProvenance({ issueId: "ENG-1432", platformDir: clone, json: true });
    const outB = logs[0] ?? "";

    expect(outA).toBe(outB);
    const parsed = JSON.parse(outA || "[]") as Array<{ issue_id: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(parsed.every((r) => r.issue_id === "ENG-1432")).toBe(true);
  });

  test("full-matrix JSON shape is stable (snapshot of req_id + role + issue_id)", async () => {
    await runProvenance({ platformDir: clone, json: true });
    const parsed = JSON.parse(logs[0] ?? "[]") as Array<Record<string, unknown>>;

    // source_file/line churn as the fixture evolves, so the snapshot holds
    // only the identity keys.
    const shape = parsed.map((r) => ({
      req_id: r.req_id,
      role: r.role,
      issue_id: r.issue_id,
    }));
    expect(shape).toMatchSnapshot();
  });
});
