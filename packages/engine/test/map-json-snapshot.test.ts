// packages/engine/test/map-json-snapshot.test.ts
//
// MAP-02 determinism lock: `spec map --json` against the canonical
// platform-fixture must produce byte-identical output across consecutive
// invocations, and the shape is pinned by a snapshot so future changes to
// the coverage VIEW columns or sort order surface immediately.
//
// Runs the citty command in-process (mirroring cli-id.test.ts /
// cli-check-unit.test.ts patterns).
//
// WR-06 review-fix: each test runs against a CLONED fixture in tmpdir so
// the canonical `fixtures/platform-fixture/` tree is never mutated.
// Previously this file rm'd `<FIXTURE>/.spec-engine/` in beforeEach / afterEach;
// the directory was gitignored but it still violated the project-wide
// invariant codified in cloneFixture.ts that the canonical fixture is
// read-only across the test suite. A developer who ran `bun run dev`
// against the canonical fixture would lose their populated index
// without warning on the next `bun test`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { mapCommand } from "../src/commands/map";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

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
  // WR-06: clone the canonical fixture into a fresh tmpdir per test so
  // the indexer's .spec-engine/ writes land outside the canonical tree.
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
    // First invocation: DB is missing → runIndex builds it; emits JSON.
    await runMap({ platformDir: clone, json: true });
    const outA = logs[0] ?? "";
    logs.length = 0;
    // Cold-state guarantee: re-clone and re-run from scratch.
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
    // Canonical fixture: 5 requirements (AUTH-001, BILLING-001, BILLING-002,
    // BILLING-007, BILLING-009) × 4 repos (spec-engine, api, mobile, admin)
    // = 20 rows from the coverage VIEW.
    expect(parsed.length).toBe(20);
  });

  test("rows are deterministically sorted by (domain_key, req_seq, repo)", async () => {
    await runMap({ platformDir: clone, json: true });
    const parsed = JSON.parse(logs[0] ?? "[]") as Array<{
      req_id: string;
      domain_key: string;
      repo: string;
    }>;

    // First 4 rows must all be AUTH-001 (one per repo, repos alphabetic).
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

    // Then BILLING in numeric seq order: 001, 002, 007, 009 — each
    // appearing 4 times before moving on.
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

    // Project only the structurally-meaningful keys for the snapshot —
    // raw test_levels / repo_pin / req_changed_at_version are derived
    // and could legitimately churn as fixture evolves; the (req, repo,
    // implemented, verified) projection is the MAP-02 contract.
    const shape = parsed.map((r) => ({
      req_id: r.req_id,
      repo: r.repo,
      implemented: r.implemented,
      verified: r.verified,
    }));
    expect(shape).toMatchSnapshot();
  });
});
