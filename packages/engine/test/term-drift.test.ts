// packages/engine/test/term-drift.test.ts
//
// Phase 6 Wave E (TERM-05, dogfooded in CHCK). The citation-drift model — the
// member-pin drift replayed ONE LEVEL UP (req → term). A requirement's `cites`
// entry implicitly PINS the term version it was confirmed against
// (`cites[].pinned`). Two drift paths, mirroring the member-pin machinery:
//
//   - TERM_DRIFT (warning): an in-place `spec term revise` bumps the cited
//     term's version → every citation pinned older DRIFTS until re-confirmed.
//     WARNING severity (like the soft coverage drift) so a lagging pin never
//     reds `spec check --ci` (exit stays 0).
//   - SUPERSEDED_TERM_REFERENCED (error): `spec supersede TERM-NNN` mints a new
//     id → a citation still on the old id fires an ERROR (clone of the Q2
//     SUPERSEDED_REFERENCED tag pattern), flipping `spec check --ci` to exit 1.
//
// `spec term confirm <REQ> <TERM>` advances the citation's pin to the term's
// current version (clearing TERM_DRIFT) and — for a SUPERSEDED term — re-points
// the citation to the successor id (clearing SUPERSEDED_TERM_REFERENCED).
//
// The `term_drift` VIEW (schema.ts, Wave A) owns the drift predicate
// (`term.changed_at_version > citation.pinned`) — a 1:1 shape-clone of the
// member-pin `drift` VIEW, NOT a forked re-spelling (CHCK-03: one predicate,
// one place). Q10 just SELECTs the VIEW.
//
// Test strategy: build a fixture platform in a tmpdir (TERM domain + a citing
// BILLING domain), then drive the real commands (revise / confirm / supersede)
// in-process and read the diagnostics through runIndex + listSemanticDiagnostics
// (mirrors check-terms.test.ts). The `spec check --ci` exit contract is EXACTLY
// `rows.some(d => d.severity === "error")` (check.ts), so severity assertions on
// the diagnostic rows prove the exit-code behavior without a member-config clone.
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec CHCK-005 integration

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Diagnostic } from "@spec-engine/shared";
import { supersedeCommand } from "../src/commands/supersede";
import { termConfirmCommand, termReviseCommand } from "../src/commands/term";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";

// The real repo root (contains spec-engine/) — the self-corpus proof.
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const reviseRun = (termReviseCommand as unknown as { run: RunFn }).run;
const confirmRun = (termConfirmCommand as unknown as { run: RunFn }).run;
const supersedeRun = (supersedeCommand as unknown as { run: RunFn }).run;

let tmp: string;
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;
let originalIsTTY: boolean | undefined;
let diagCounter: number;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-term-drift-"));
  logs = [];
  errs = [];
  diagCounter = 0;
  originalLog = console.log;
  originalErr = console.error;
  originalExit = process.exit;
  originalIsTTY = process.stdin.isTTY;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new ExitError(code ?? 0);
  };
  // supersede requires non-TTY + --text (the successor's truth cannot be prompted).
  Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  rmSync(tmp, { recursive: true, force: true });
});

/** Write a domain file under the fixture platform. */
function writeDomain(root: string, key: string, body: unknown): void {
  const dir = join(root, "spec-engine", key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SPEC.json"), `${JSON.stringify(body, null, 2)}\n`);
}

/** Build the fixture: a TERM domain (TERM-001 "Domain") + a citing BILLING
 *  domain (BILLING-001 cites TERM-001 pinned @1). Both draft so no coverage
 *  diagnostic (ORPHAN_REQ / UNVERIFIED_REQ) adds noise — only the term
 *  diagnostics fire. */
function buildFixture(root: string): void {
  writeDomain(root, "TERM", {
    key: "TERM",
    owner: null,
    specVersion: 1,
    updated: "2026-07-08",
    requirements: [
      {
        id: "TERM-001",
        status: "active",
        statement: "Domain — a bounded area of the spec taxonomy.",
        term: "Domain",
        aliases: [],
        changedAtVersion: 1,
      },
    ],
  });
  writeDomain(root, "BILLING", {
    key: "BILLING",
    owner: "drea",
    specVersion: 1,
    updated: "2026-07-08",
    requirements: [
      {
        id: "BILLING-001",
        status: "draft",
        statement: "A charge belongs to exactly one billing Domain.",
        cites: [{ term: "TERM-001", pinned: 1 }],
      },
    ],
  });
}

/** Cold-read the semantic diagnostics for `platformDir` through a fresh index. */
async function diagnose(platformDir: string): Promise<Diagnostic[]> {
  const dbPath = join(tmp, `idx-${diagCounter++}.sqlite`);
  const s = openStorage(dbPath);
  try {
    await runIndex({ platformDir, storage: s });
    return s.listSemanticDiagnostics() as unknown as Diagnostic[];
  } finally {
    s.close();
  }
}

/** Read the citing BILLING-001's first citation ({ term, pinned }). */
function readCitation(root: string): { term: string; pinned: number } {
  const doc = JSON.parse(readFileSync(join(root, "spec-engine", "BILLING", "SPEC.json"), "utf8"));
  const req = doc.requirements.find((r: { id: string }) => r.id === "BILLING-001");
  return req.cites[0];
}

describe("TERM-05 — the citation-drift cycle (member-pin drift, one level up)", () => {
  test("cite → revise → TERM_DRIFT → confirm → clear; supersede → superseded-ref → re-point → clear", async () => {
    buildFixture(tmp);

    // Baseline: fresh citation pinned at the term's current version — no drift.
    const base = await diagnose(tmp);
    expect(base.some((d) => d.code === "TERM_DRIFT")).toBe(false);
    expect(base.some((d) => d.code === "SUPERSEDED_TERM_REFERENCED")).toBe(false);

    // ── Test 1: revise bumps the term version → TERM_DRIFT (warning) fires ──
    await reviseRun({
      args: {
        id: "TERM-001",
        def: "Domain — a bounded, owned area of the spec taxonomy.",
        platformDir: tmp,
      },
      rawArgs: [],
    });
    const afterRevise = await diagnose(tmp);
    const drift = afterRevise.find((d) => d.code === "TERM_DRIFT" && d.req_id === "BILLING-001");
    expect(drift).toBeDefined();
    expect(drift?.severity).toBe("warning");
    expect(drift?.repo).toBeNull();
    // `spec check --ci` exit contract IS `rows.some(severity === "error")`.
    // A drift-only platform has no error → check --ci exits 0.
    expect(afterRevise.some((d) => d.severity === "error")).toBe(false);

    // ── Test 2: confirm advances the pin to the term's current version → clears ──
    await confirmRun({
      args: { reqId: "BILLING-001", termId: "TERM-001", platformDir: tmp },
      rawArgs: [],
    });
    expect(readCitation(tmp)).toEqual({ term: "TERM-001", pinned: 2 });
    const afterConfirm = await diagnose(tmp);
    expect(afterConfirm.some((d) => d.code === "TERM_DRIFT")).toBe(false);

    // ── Test 3: supersede the cited term → SUPERSEDED_TERM_REFERENCED (error) ──
    await supersedeRun({
      args: {
        id: "TERM-001",
        text: "Domain — a bounded, owned partition of the taxonomy.",
        platformDir: tmp,
      },
      rawArgs: [],
    });
    const afterSupersede = await diagnose(tmp);
    const superRef = afterSupersede.find(
      (d) => d.code === "SUPERSEDED_TERM_REFERENCED" && d.req_id === "BILLING-001",
    );
    expect(superRef).toBeDefined();
    expect(superRef?.severity).toBe("error");
    expect(superRef?.repo).toBeNull();
    expect(superRef?.detail).toContain("TERM-002");
    // An error-severity diagnostic → check --ci exits 1.
    expect(afterSupersede.some((d) => d.severity === "error")).toBe(true);

    // ── Test 4: confirm re-points the citation to the successor → clears ──
    await confirmRun({
      args: { reqId: "BILLING-001", termId: "TERM-001", platformDir: tmp },
      rawArgs: [],
    });
    // Re-pointed to the successor, pinned to the TERM domain's current
    // specVersion (3 after the supersede bump). The successor is a supersession
    // TARGET, so the index computes its changed_at_version = specVersion (3),
    // NOT its authored changedAtVersion (1) — pinning to specVersion clears it.
    expect(readCitation(tmp)).toEqual({ term: "TERM-002", pinned: 3 });
    const afterRepoint = await diagnose(tmp);
    expect(afterRepoint.some((d) => d.code === "SUPERSEDED_TERM_REFERENCED")).toBe(false);
    expect(afterRepoint.some((d) => d.code === "TERM_DRIFT")).toBe(false);
    expect(afterRepoint.some((d) => d.code === "UNDEFINED_TERM")).toBe(false);
    expect(afterRepoint.some((d) => d.severity === "error")).toBe(false);
  });

  // ── Test 5: self-corpus — the citation-free real platform fires neither ──
  test("self-corpus fires neither TERM_DRIFT nor SUPERSEDED_TERM_REFERENCED", async () => {
    const rows = await diagnose(REPO_ROOT);
    expect(rows.some((d) => d.code === "TERM_DRIFT")).toBe(false);
    expect(rows.some((d) => d.code === "SUPERSEDED_TERM_REFERENCED")).toBe(false);
  });
});
