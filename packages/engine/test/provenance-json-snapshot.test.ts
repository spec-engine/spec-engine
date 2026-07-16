// packages/engine/test/provenance-json-snapshot.test.ts
//
// PMAT-02 determinism lock: `spec provenance --json` against the canonical
// platform-fixture must produce byte-identical output across two CONSECUTIVE
// COLD rebuilds (rm the clone → re-clone → re-run from scratch), and the shape
// is pinned by a snapshot so future changes to the ProvenanceMatrixRow columns
// or the composite-key sort surface immediately. This is the test the research
// (Pitfall 2) calls for: cloned structurally from map-json-snapshot.test.ts,
// swapping mapCommand → provenanceCommand.
//
// Two surfaces are locked:
//   A) full matrix      — `spec provenance <clone> --json`
//   B) reverse lookup   — `spec provenance ENG-1432 <clone> --json` (PMAT-03)
// Both must be byte-identical across cold rebuilds AND non-empty (length > 2
// for A's serialized array; >= 1 rows for B's parsed array).
//
// Runs the citty command in-process (mirroring map-json-snapshot.test.ts /
// cli-provenance-unit.test.ts).
//
// WR-06 invariant: each test runs against a CLONED fixture in tmpdir so the
// canonical `fixtures/platform-fixture/` tree is never mutated — the harness
// is copied verbatim from map-json-snapshot.test.ts (cloneFixture per test,
// console.log capture, ExitError exit stub, afterEach restore).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { provenanceCommand } from "../src/commands/provenance";
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
  test("A: full matrix is byte-identical across two cold rebuilds (PMAT-02)", async () => {
    // First cold run: clone's DB is missing → runIndex builds it; emits JSON.
    await runProvenance({ platformDir: clone, json: true });
    const outA = logs[0] ?? "";
    logs.length = 0;
    // Cold-state guarantee: rm the clone and re-clone so the second run
    // rebuilds the derived index from scratch (true cold rebuild).
    rmSync(clone, { recursive: true, force: true });
    clone = cloneFixture(FIXTURE);
    await runProvenance({ platformDir: clone, json: true });
    const outB = logs[0] ?? "";

    expect(outA).toBe(outB);
    expect(outA.length).toBeGreaterThan(2); // not just "[]"
  });

  test("B: reverse lookup ENG-1432 is byte-identical across two cold rebuilds, length >= 1 (PMAT-02/03)", async () => {
    await runProvenance({ issueId: "ENG-1432", platformDir: clone, json: true });
    const outA = logs[0] ?? "";
    logs.length = 0;
    rmSync(clone, { recursive: true, force: true });
    clone = cloneFixture(FIXTURE);
    await runProvenance({ issueId: "ENG-1432", platformDir: clone, json: true });
    const outB = logs[0] ?? "";

    expect(outA).toBe(outB);
    // Every returned row is the opaque issue ENG-1432; at least one exists.
    const parsed = JSON.parse(outA || "[]") as Array<{ issue_id: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(parsed.every((r) => r.issue_id === "ENG-1432")).toBe(true);
  });

  test("full-matrix JSON shape is stable (snapshot of req_id + role + issue_id)", async () => {
    await runProvenance({ platformDir: clone, json: true });
    const parsed = JSON.parse(logs[0] ?? "[]") as Array<Record<string, unknown>>;

    // Project only the structurally-meaningful identity keys for the
    // snapshot — source_file/line are git pointers that could legitimately
    // churn as the fixture evolves; the (req_id, role, issue_id) projection
    // is the PMAT-02 composite-key-sort contract.
    const shape = parsed.map((r) => ({
      req_id: r.req_id,
      role: r.role,
      issue_id: r.issue_id,
    }));
    expect(shape).toMatchSnapshot();
  });
});
