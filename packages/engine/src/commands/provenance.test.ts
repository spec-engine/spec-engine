import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProvenanceMatrixRow } from "@spec-engine/shared";
import { cloneFixture } from "../testing/cloneFixture";
import { provenanceCommand } from "./provenance";

const PLATFORM_FIXTURE = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "platform-fixture",
);

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
  tmp = mkdtempSync(join(tmpdir(), "spec-cli-provenance-"));
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
const provenanceRun = (provenanceCommand as unknown as { run: RunFn }).run;

/** -1 when provenance returned without calling process.exit: an implicit exit 0. */
async function runProvenance(args: Record<string, unknown>): Promise<number> {
  try {
    await provenanceRun({ args, rawArgs: [] });
    return -1;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

/** Strips any stale index leftovers so the command builds a fresh one. */
function clonePlatformFixture(): string {
  const clone = cloneFixture(PLATFORM_FIXTURE);
  rmSync(join(clone, ".spec-engine"), { recursive: true, force: true });
  return clone;
}

function jsonRows(): ProvenanceMatrixRow[] {
  const jsonLine = logs.find((l) => l.startsWith("["));
  expect(jsonLine).toBeDefined();
  return JSON.parse(jsonLine as string) as ProvenanceMatrixRow[];
}

describe("spec provenance — full matrix, no issue id", () => {
  test("text mode renders BILLING-009's creating + revising issues and the git pointer", async () => {
    const clone = clonePlatformFixture();
    try {
      // A lone positional that resolves to a directory is the platformDir.
      const code = await runProvenance({ issueId: clone });
      expect(code).toBe(-1);
      const out = logs.join("\n");
      expect(out).toMatch(/BILLING-009\s+\[Active\]/);
      // Both links share the line of BILLING-009's `"id"` key in SPEC.json.
      expect(out).toContain("created  ENG-1432  spec-engine/BILLING/SPEC.json:26");
      expect(out).toContain("supersedes-via  ENG-1781  spec-engine/BILLING/SPEC.json:26");
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  test("--json emits a parseable, non-empty JSON array", async () => {
    const clone = clonePlatformFixture();
    try {
      const code = await runProvenance({ issueId: clone, json: true });
      expect(code).toBe(-1);
      const rows = jsonRows();
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const issues = new Set(rows.map((r) => r.issue_id));
      expect(issues.size).toBeGreaterThan(1);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describe("spec provenance — reverse lookup exact filter", () => {
  test("ENG-1432 returns >= 1 row and EVERY row has issue_id === 'ENG-1432'", async () => {
    const clone = clonePlatformFixture();
    try {
      const code = await runProvenance({ issueId: "ENG-1432", platformDir: clone, json: true });
      expect(code).toBe(-1);
      const rows = jsonRows();
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        expect(row.issue_id).toBe("ENG-1432");
      }
      // ENG-1432 is seeded as `created` on BILLING-009.
      expect(rows.some((r) => r.req_id === "BILLING-009" && r.role === "created")).toBe(true);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describe("spec provenance — missing-id reverse lookup", () => {
  test("a non-existent issue id returns exactly '[]' with no crash", async () => {
    const clone = clonePlatformFixture();
    try {
      const code = await runProvenance({ issueId: "ENG-NOPE", platformDir: clone, json: true });
      expect(code).toBe(-1);
      const jsonLine = logs.find((l) => l.startsWith("["));
      expect(jsonLine).toBe("[]");
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describe("spec provenance — KEY-NNN opaque-id stays opaque", () => {
  test("BILLING-001 used as an ISSUE id (on AUTH-001) is filtered as an opaque value, NOT resolved as a requirement", async () => {
    const clone = clonePlatformFixture();
    try {
      const code = await runProvenance({ issueId: "BILLING-001", platformDir: clone, json: true });
      expect(code).toBe(-1);
      const rows = jsonRows();
      // The fixture records `created: BILLING-001` on AUTH-001.
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        expect(row.issue_id).toBe("BILLING-001");
      }
      expect(rows.some((r) => r.req_id === "AUTH-001")).toBe(true);
      // The BILLING-001 requirement links ENG-1100, which would leak in if
      // issue_id were used as an identity key.
      expect(rows.some((r) => r.req_id === "BILLING-001")).toBe(false);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});
