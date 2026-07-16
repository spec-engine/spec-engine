// packages/engine/test/cli-propagation-unit.test.ts
//
// Unit tests for `spec propagation` (commands/propagation.ts). In-process
// invocation of the citty command with process.exit stubbed to throw
// ExitError so the test runner can assert on the exit code without
// terminating.
//
// Scope: COMMAND-level behavior — empty-reqId guard, V12 path-containment,
// JSON shape against the canonical fixture trace, and text-mode column
// headers. The storage-seam fixture trace is locked separately in
// propagation.test.ts (plan 04-02); this file locks the CLI surface.
//
// Mirrors the harness pattern from cli-check-unit.test.ts (ExitError,
// beforeEach stub block, RunFn cast). Tests that touch the platform fixture
// use cloneFixture (WR-06) so fixtures/platform-fixture/ is never mutated.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PropagationState } from "@spec-engine/shared";
import { propagationCommand } from "../src/commands/propagation";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
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
  // WR-06: clone the canonical fixture into a fresh tmpdir per test so
  // the indexer's .spec-engine/ writes land outside the canonical tree.
  clone = cloneFixture(FIXTURE);
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
  rmSync(clone, { recursive: true, force: true });
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const propagationRun = (propagationCommand as unknown as { run: RunFn }).run;

async function runPropagation(args: Record<string, unknown>): Promise<number> {
  try {
    await propagationRun({ args, rawArgs: [] });
    // Success path: commands/propagation.ts does not call process.exit on
    // success — citty exits 0 on normal return. Mirror map-json-snapshot.
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

describe("spec propagation (in-process)", () => {
  test("empty reqId exits 2 with usage message on stderr", async () => {
    const code = await runPropagation({ reqId: "" });
    expect(code).toBe(2);
    expect(errs[0] ?? "").toMatch(/spec propagation: <reqId> is required/);
  });

  test("whitespace-only reqId is treated as empty (exits 2)", async () => {
    const code = await runPropagation({ reqId: "   " });
    expect(code).toBe(2);
    expect(errs[0] ?? "").toMatch(/spec propagation: <reqId> is required/);
  });

  test("BILLING-009 against cloned fixture --json: 3 rows with documented states", async () => {
    const code = await runPropagation({
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(0);

    const parsed = JSON.parse(logs[0] ?? "[]");
    expect(parsed.length).toBe(3);

    const api = parsed.find((r: { repo: string }) => r.repo === "api");
    expect(api).toEqual({
      repo: "api",
      state: PropagationState.MIGRATED_VERIFIED,
      via_req_id: null,
      drifted: false,
    });

    const mobile = parsed.find((r: { repo: string }) => r.repo === "mobile");
    expect(mobile).toEqual({
      repo: "mobile",
      state: PropagationState.ON_PREDECESSOR,
      via_req_id: "BILLING-001",
      drifted: true,
    });

    const admin = parsed.find((r: { repo: string }) => r.repo === "admin");
    expect(admin).toEqual({
      repo: "admin",
      state: PropagationState.ON_OTHER_DOMAIN_REQ,
      via_req_id: "BILLING-007",
      drifted: false,
    });
  });

  test("--out outside platformDir exits 2 with V12 message", async () => {
    const code = await runPropagation({
      reqId: "BILLING-009",
      platformDir: clone,
      out: "/etc/passwd",
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/--out path must be inside platformDir/);
  });

  test("text mode renders header columns REPO STATE VIA DRIFT?", async () => {
    const code = await runPropagation({
      reqId: "BILLING-009",
      platformDir: clone,
      json: false,
    });
    expect(code).toBe(0);

    const out = logs[0] ?? "";
    expect(out).toContain("REPO");
    expect(out).toContain("STATE");
    expect(out).toContain("VIA");
    expect(out).toContain("DRIFT?");

    expect(out).toContain("MIGRATED_VERIFIED");
    expect(out).toContain("ON_PREDECESSOR");
    expect(out).toContain("ON_OTHER_DOMAIN_REQ");

    expect(out).toContain("BILLING-001");
    expect(out).toContain("BILLING-007");

    // Em-dash literal for api's null via_req_id (state MIGRATED_VERIFIED).
    expect(out).toContain("—");
  });
});

// ---------- RED-11: pre-index / pre-spec guidance ----------

describe("spec propagation — pre-index guidance (RED-11)", () => {
  test("non-platform dir: friendly message + exit 2, no stack trace, no .spec-engine artifact", async () => {
    const bare = mkdtempSync(join(tmpdir(), "spec-prop-red11-"));
    try {
      const code = await runPropagation({ reqId: "BILLING-009", platformDir: bare });
      expect(code).toBe(2);
      expect(errs.some((m) => m.includes("is not a spec-check platform yet"))).toBe(true);
      // Directs the user toward their first completed spec.
      expect(errs.some((m) => m.includes("spec domain new"))).toBe(true);
      expect(errs.some((m) => m.includes("spec req"))).toBe(true);
      // No leaked stack frames.
      expect(errs.some((m) => /\n\s+at\s/.test(m) || m.includes("    at "))).toBe(false);
      // Guard runs BEFORE mkdirSync/openStorage: nothing written.
      expect(existsSync(join(bare, ".spec-engine"))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
