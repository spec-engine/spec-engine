// packages/engine/test/gate-rung3.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec GATE-006
//
// Phase 06 Plan 04 Task 2 — GATE-04 demonstration (ROADMAP Success
// Criterion #3): the rung-3 narrative.
//
//   R3 — plant a BILLING-010 tag in a cloned member file
//        (api/src/renew.ts is appended in-place). First gate run:
//        BILLING-010 does not yet exist in the canonical spec → exit 1
//        with reason NOT_FOUND. Then mutate the cloned BILLING/SPEC.md
//        to add a new Active BILLING-010 entry. Second gate run with
//        identical args → exit 0 reason PASS. The two-element capture
//        `[reason1, reason2] === ["NOT_FOUND", "PASS"]` is the single
//        most expressive assertion of the rung-3 contract.
//
// changed_at_version derivation: BILLING-010 lands as a NEW Active req
// in the BILLING domain (spec_version=2) with no supersession
// relationship. Per parser/spec.ts:240-248 the parser defaults its
// changed_at_version to 1 (the "unchanged-since-v1" default). Since
// api is pinned @2 and 1 <= 2, the second run is PASS (the strict
// greater-than predicate in classify.ts:110 only fires when
// changed_at_version > pin).
//
// This test file does NOT depend on bun:sqlite — gate-rung3.test.ts is
// a pure CLI-seam test. The D-08 grep-fence is therefore preserved
// inside this file's scope (the cold-rebuild sibling is the only test
// file with a legitimate bun:sqlite reach, and it goes through helpers).
//
// WR-06 invariant (T-06-04-01): every test calls cloneFixture(FIXTURE)
// in beforeEach. afterEach rmSync's the clone. fixtures/platform-fixture/
// is NEVER mutated.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gateCommand } from "../src/commands/gate";
import { cloneFixture } from "./fixtures/cloneFixture";
import { specTag } from "./fixtures/specTag";

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

describe("spec gate rung-3 flow (GATE-04 / ROADMAP Success Criterion #3)", () => {
  // ---------------------------------------------------------------------
  // R3 — BILLING-010 add-and-rerun. The full rung-3 narrative in one
  // test: a member-side reference to a new requirement triggers
  // NOT_FOUND; adding that requirement to the canonical spec turns the
  // very next gate run green.
  // ---------------------------------------------------------------------
  test("R3: BILLING-010 member plant → NOT_FOUND → add to spec → PASS", async () => {
    // Step 1: plant a BILLING-010 tag in api/src/renew.ts. The
    // tag scanner picks up the new ref; runIndex enters it into `tags`
    // but `requirements` has no BILLING-010 row yet. The api repo is
    // pinned @2, so once BILLING-010 lands in the spec at any
    // changed_at_version <= 2, gate will return PASS.
    //
    // We APPEND the tag (preserving the existing BILLING-009 binding
    // — the member file remains compilable, and both tags coexist
    // on the same function declaration in real usage).
    const memberPath = join(clone, "api", "src", "renew.ts");
    const memberBefore = readFileSync(memberPath, "utf8");
    // Sanity: the canonical fixture renew.ts ships with the BILLING-009
    // tag — if that ever changes, this test's plant logic needs revisit.
    expect(memberBefore).toContain(specTag("BILLING-009").trimEnd());
    appendFileSync(
      memberPath,
      `\n${specTag("BILLING-010")}export function rungThree() {\n  /* PoC */\n}\n`,
    );

    // Step 2: first run — BILLING-010 not in spec → NOT_FOUND.
    const code1 = await runGate({
      repo: "api",
      reqId: "BILLING-010",
      platformDir: clone,
      json: true,
    });
    expect(code1).toBe(1);
    const out1 = lastLogAsJson<{ reason: string }>();
    const reason1 = out1.reason;

    // Step 3: append BILLING-010 to the cloned canonical spec. Fixture migrated
    // to JSON in 18-03: push a NEW active requirement into the structured
    // envelope (not superseded / not superseding → changed_at_version defaults
    // to 1 via domainJson's second pass).
    const specPath = join(clone, "spec-engine", "BILLING", "SPEC.json");
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    spec.requirements.push({
      id: "BILLING-010",
      status: "active",
      statement: "Rung-3 demonstration requirement added mid-test.",
      why: "GATE-04 locks the rung-3 narrative for ROADMAP Success Criterion #3.",
      supersedes: null,
      supersededBy: null,
      relates: [],
      livesIn: ["renew.ts"],
      issues: [],
    });
    writeFileSync(specPath, JSON.stringify(spec, null, 2));

    // Clear stdout buffer so the second run reads cleanly.
    logs.length = 0;
    errs.length = 0;

    // Step 4: second run — same args. The cold rm trio reindexes from
    // the mutated spec; BILLING-010 is now Active, changed_at_version
    // defaults to 1, api is pinned @2 → PASS.
    const code2 = await runGate({
      repo: "api",
      reqId: "BILLING-010",
      platformDir: clone,
      json: true,
    });
    expect(code2).toBe(0);
    const out2 = lastLogAsJson<{ reason: string }>();
    const reason2 = out2.reason;

    // Side-by-side assertion — the single most expressive form of the
    // rung-3 contract.
    expect([reason1, reason2]).toEqual(["NOT_FOUND", "PASS"]);
  });
});
