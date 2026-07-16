// packages/engine/test/cli-provenance-unit.test.ts
//
// PMAT-03: unit tests for `spec provenance` (commands/provenance.ts) at the
// COMMAND layer. In-process invocation of the citty command with
// process.exit stubbed to throw ExitError — cloned verbatim from
// cli-relations-unit.test.ts.
//
// Scope:
//   (a) full matrix (no issue id): text mode renders per-requirement
//       provenance — BILLING-009's creating (ENG-1432) + revising (ENG-1781)
//       issues and the source_file:line git pointer; --json emits a
//       parseable, non-empty JSON array.
//   (b) reverse lookup (`spec provenance <ISSUE-ID> <platformDir>`): filters
//       to one opaque issue. ENG-1432 returns >= 1 row and EVERY returned row
//       has issue_id === "ENG-1432" (the filter is exact and opaque).
//   (c) missing-id reverse lookup → "[]" (no crash).
//   (d) SC3 opacity: a KEY-NNN-shaped opaque id (BILLING-001, authored as the
//       issue id on AUTH-001) returns the AUTH-001 link and does NOT resolve
//       BILLING-001 as a requirement — proving issue_id stays an opaque filter
//       value, never an identity key.
//
// Storage is exercised through openStorage inside the command — these are
// integration-flavored command tests; provenance-format.test.ts owns the
// pure-formatter cases. No bun:sqlite import here (D-08).
//
// All runs use a CLONED fixture (cloneFixture into tmpdir) — the canonical
// fixtures/platform-fixture/ is NEVER mutated.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProvenanceMatrixRow } from "@spec-engine/shared";
import { provenanceCommand } from "../src/commands/provenance";
import { cloneFixture } from "./fixtures/cloneFixture";

const PLATFORM_FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

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

/** Run provenance in-process. Returns the exit code if the command called
 *  process.exit, or -1 if it returned normally (implicit exit 0). */
async function runProvenance(args: Record<string, unknown>): Promise<number> {
  try {
    await provenanceRun({ args, rawArgs: [] });
    return -1;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

/** Clone platform-fixture into tmp and strip any stale committed-index
 *  leftovers so the command builds a FRESH derived index (the canonical
 *  truth is the spec — CLAUDE.md: delete + rebuild must be identical). */
function clonePlatformFixture(): string {
  const clone = cloneFixture(PLATFORM_FIXTURE);
  rmSync(join(clone, ".spec-engine"), { recursive: true, force: true });
  return clone;
}

/** Parse the single JSON-array line from captured stdout. */
function jsonRows(): ProvenanceMatrixRow[] {
  const jsonLine = logs.find((l) => l.startsWith("["));
  expect(jsonLine).toBeDefined();
  return JSON.parse(jsonLine as string) as ProvenanceMatrixRow[];
}

describe("spec provenance — full matrix, no issue id (a)", () => {
  test("text mode renders BILLING-009's creating + revising issues and the git pointer", async () => {
    const clone = clonePlatformFixture();
    try {
      // Single positional that resolves to a directory => platformDir (full matrix).
      const code = await runProvenance({ issueId: clone });
      expect(code).toBe(-1); // implicit exit 0
      const out = logs.join("\n");
      // Per-requirement header for the Active BILLING-009.
      expect(out).toMatch(/BILLING-009\s+\[Active\]/);
      // Both of BILLING-009's links: created ENG-1432 + supersedes-via ENG-1781,
      // each with the source_file:line git pointer. Fixture migrated to JSON in
      // 18-03: the domainJson reader derives line from the `"id": "BILLING-009"`
      // scan (line 26 in the migrated SPEC.json), shared by both of its issues.
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
      // The full matrix carries multiple distinct issues (not a single filter).
      const issues = new Set(rows.map((r) => r.issue_id));
      expect(issues.size).toBeGreaterThan(1);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describe("spec provenance — reverse lookup exact filter (b)", () => {
  test("ENG-1432 returns >= 1 row and EVERY row has issue_id === 'ENG-1432'", async () => {
    const clone = clonePlatformFixture();
    try {
      const code = await runProvenance({ issueId: "ENG-1432", platformDir: clone, json: true });
      expect(code).toBe(-1);
      const rows = jsonRows();
      expect(rows.length).toBeGreaterThanOrEqual(1);
      // The filter is exact and opaque: no other issue's links leak through.
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

describe("spec provenance — missing-id reverse lookup (c)", () => {
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

describe("spec provenance — KEY-NNN opaque-id stays opaque (d / SC3)", () => {
  test("BILLING-001 used as an ISSUE id (on AUTH-001) is filtered as an opaque value, NOT resolved as a requirement", async () => {
    const clone = clonePlatformFixture();
    try {
      const code = await runProvenance({ issueId: "BILLING-001", platformDir: clone, json: true });
      expect(code).toBe(-1);
      const rows = jsonRows();
      // The fixture authors `**Issues:** created:BILLING-001` on AUTH-001:
      // a KEY-NNN-shaped string used as an OPAQUE issue id.
      expect(rows.length).toBeGreaterThanOrEqual(1);
      // Every returned row carries issue_id === "BILLING-001" (exact opaque match).
      for (const row of rows) {
        expect(row.issue_id).toBe("BILLING-001");
      }
      // It resolves the AUTH-001 LINK (req_id = AUTH-001), proving the filter
      // matched on the opaque issue_id payload.
      expect(rows.some((r) => r.req_id === "AUTH-001")).toBe(true);
      // SC3: BILLING-001 is NEVER resolved as a REQUIREMENT id. The actual
      // BILLING-001 requirement is linked to issue ENG-1100 — if issue_id were
      // (mis)used as an identity key, that link would leak in. It must not.
      expect(rows.some((r) => r.req_id === "BILLING-001")).toBe(false);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});
