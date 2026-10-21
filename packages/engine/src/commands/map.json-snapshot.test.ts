import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { cloneFixture } from "../testing/cloneFixture";
import { mapCommand } from "./map";

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
const mapRun = (mapCommand as unknown as { run: RunFn }).run;

async function runMap(args: Record<string, unknown>): Promise<number> {
  try {
    await mapRun({ args, rawArgs: [] });
    return 0; // map command does not call process.exit on success
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

describe("spec map --json against canonical platform-fixture", () => {
  test("two consecutive invocations produce byte-identical output", async () => {
    await runMap({ platformDir: clone, json: true });
    const outA = logs[0] ?? "";
    logs.length = 0;
    rmSync(clone, { recursive: true, force: true });
    clone = cloneFixture(FIXTURE);
    await runMap({ platformDir: clone, json: true });
    const outB = logs[0] ?? "";

    expect(outA).toBe(outB);
    expect(outA.length).toBeGreaterThan(2); // not just "[]"
  });

  test("row count = 5 requirements × 4 repos = 20 rows", async () => {
    await runMap({ platformDir: clone, json: true });
    const parsed = JSON.parse(logs[0] ?? "[]");
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(20);
  });

  test("rows are deterministically sorted by (domain_key, req_seq, repo)", async () => {
    await runMap({ platformDir: clone, json: true });
    const parsed = JSON.parse(logs[0] ?? "[]") as Array<{
      req_id: string;
      domain_key: string;
      repo: string;
    }>;

    expect(parsed.slice(0, 4).map((r) => r.req_id)).toEqual([
      "AUTH-001",
      "AUTH-001",
      "AUTH-001",
      "AUTH-001",
    ]);
    expect(parsed.slice(0, 4).map((r) => r.repo)).toEqual([
      "admin",
      "api",
      "mobile",
      "spec-engine",
    ]);

    const reqOrder = parsed.map((r) => r.req_id);
    const expectedReqOrder = [
      "AUTH-001",
      "BILLING-001",
      "BILLING-002",
      "BILLING-007",
      "BILLING-009",
    ].flatMap((id) => [id, id, id, id]);
    expect(reqOrder).toEqual(expectedReqOrder);
  });

  test("JSON shape is stable (snapshot of req_ids + repos + flags)", async () => {
    await runMap({ platformDir: clone, json: true });
    const parsed = JSON.parse(logs[0] ?? "[]") as Array<Record<string, unknown>>;

    // test_levels, repo_pin and req_changed_at_version churn as the fixture
    // evolves, so the snapshot holds only the identity and coverage keys.
    const shape = parsed.map((r) => ({
      req_id: r.req_id,
      repo: r.repo,
      implemented: r.implemented,
      verified: r.verified,
    }));
    expect(shape).toMatchSnapshot();
  });
});
