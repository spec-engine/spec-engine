// packages/engine/test/cli-check-unit.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec CHCK-003
//
// Unit tests for `spec check` (commands/check.ts). In-process invocation
// of the citty command with process.exit stubbed to throw ExitError so
// the test runner can assert on the exit code without terminating.
//
// Scope: COMMAND-level behavior — path-containment guard, --ci no-op on
// empty dir, --json parseability, exit code wiring. The full inverted-CI
// exact-match assertion is plan 03-05's job (check-ci.test.ts).
//
// Mirrors the pattern from cli-new.test.ts (ExitError, beforeEach stub
// block, RunFn cast).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkCommand } from "../src/commands/check";
import { cloneFixture } from "./fixtures/cloneFixture";
import { specTag } from "./fixtures/specTag";

// Canonical platform fixture (read-only across the suite — all mutating
// runs operate on a cloneFixture() copy). Mirrors check-ci.test.ts.
const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let tmp: string;
let clones: string[];
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
  tmp = mkdtempSync(join(tmpdir(), "spec-cli-check-"));
  clones = [];
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
  for (const c of clones) {
    rmSync(c, { recursive: true, force: true });
  }
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const checkRun = (checkCommand as unknown as { run: RunFn }).run;

async function runCheck(args: Record<string, unknown>): Promise<number> {
  try {
    await checkRun({ args, rawArgs: [] });
    return -1; // unreachable — run() always calls process.exit
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

/** Write a domain's SPEC.json envelope (D2: JSON is the sole spec format). */
function writeDomainJson(
  root: string,
  key: string,
  requirements: Array<Record<string, unknown>>,
): void {
  mkdirSync(join(root, "spec-engine", key), { recursive: true });
  writeFileSync(
    join(root, "spec-engine", key, "SPEC.json"),
    JSON.stringify(
      { key, owner: "drea", specVersion: 1, updated: "2026-06-03", requirements },
      null,
      2,
    ),
  );
}

/** Minimal canonical-only fixture: one repo (spec-engine) with one Active
 *  requirement. No members, no tags. Should produce ORPHAN_REQ (and nothing
 *  else) — so exit code is 1, JSON output parseable. */
function makeOrphanFixture(root: string): void {
  mkdirSync(join(root, "spec-engine"), { recursive: true });
  writeDomainJson(root, "TEST", [
    {
      id: "TEST-001",
      status: "active",
      statement: "Orphan req for the unit test.",
      why: "Drives an ORPHAN_REQ diagnostic.",
      supersedes: null,
      supersededBy: null,
      relates: [],
      livesIn: [],
      issues: [],
    },
  ]);
}

/** Clean fixture: one Active requirement with a tag in a member. Should
 *  produce 0 diagnostics (no orphan, no unverified because no implements
 *  exists either — wait, untagged requirement = ORPHAN_REQ. To get 0
 *  diagnostics we need both implements + verifies tags). */
function makeCleanFixture(root: string): void {
  mkdirSync(join(root, "spec-engine"), { recursive: true });
  writeDomainJson(root, "TEST", [
    {
      id: "TEST-001",
      status: "active",
      statement: "Clean req — tagged by src AND test.",
      why: "Drives 0 diagnostics.",
      supersedes: null,
      supersededBy: null,
      relates: [],
      livesIn: [],
      issues: [],
    },
  ]);
  mkdirSync(join(root, "member", "src"), { recursive: true });
  mkdirSync(join(root, "member", "test"), { recursive: true });
  writeFileSync(
    join(root, "member", "spec-engine.member.json"),
    JSON.stringify({ specs: "spec-engine@1" }),
  );
  writeFileSync(
    join(root, "member", "src", "feature.ts"),
    `${specTag("TEST-001")}export const x = 1;\n`,
  );
  writeFileSync(
    join(root, "member", "test", "feature.test.ts"),
    `${specTag("TEST-001")}export const y = 2;\n`,
  );
}

/** Warning-only fixture: canonical spec-engine/ + one sibling directory
 *  WITHOUT spec-engine.member.json. Phase 8 emits one NO_SPEC_CONFIG warning;
 *  no error-severity rows fire (no requirements means no ORPHAN_REQ either).
 *  Used to exercise the `check.ts:127` `severity === "error"` branch for
 *  the first time ever with a warning-only diagnostic set. */
function makeWarningOnlyFixture(root: string): void {
  mkdirSync(join(root, "spec-engine"), { recursive: true });
  mkdirSync(join(root, "strangers"), { recursive: true });
  // No spec-engine.member.json in strangers — Phase 8 emits NO_SPEC_CONFIG warning.
  // RUNG1-02: `strangers/` must carry a repo-root marker (.git/package.json)
  // to be classified as a SKIPPED sibling (a real unwired member repo).
  // Without a marker it is a bucket-3 plain folder and is ignored — which
  // would also make this a lone self-member instead of a warning fixture.
  writeFileSync(join(root, "strangers", "package.json"), JSON.stringify({ name: "strangers" }));
}

/** Mixed fixture: orphan-requirement error (ORPHAN_REQ from makeOrphanFixture)
 *  + a sibling-without-config (NO_SPEC_CONFIG warning). Used to prove the
 *  `severity === "error"` exit-code branch dominates when both rows are
 *  present (DIAG-02 sub-criterion 2). */
function makeMixedFixture(root: string): void {
  makeOrphanFixture(root);
  mkdirSync(join(root, "strangers"), { recursive: true });
  // RUNG1-02: marker required so `strangers/` is a skipped sibling →
  // NO_SPEC_CONFIG warning (paired with the ORPHAN_REQ error from
  // makeOrphanFixture to prove the error branch dominates the exit code).
  writeFileSync(join(root, "strangers", "package.json"), JSON.stringify({ name: "strangers" }));
}

describe("spec check — path-containment guard (V12)", () => {
  test("--out resolving outside platformDir rejects with exit 2", async () => {
    // tmp is `/tmp/spec-cli-check-XXX`. outside is a sibling.
    const outside = mkdtempSync(join(tmpdir(), "spec-cli-check-outside-"));
    try {
      const code = await runCheck({ platformDir: tmp, out: join(outside, "evil.sqlite") });
      expect(code).toBe(2);
      expect(errs.some((m) => m.includes("--out path must be inside platformDir"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("--out resolving inside platformDir is accepted", async () => {
    makeOrphanFixture(tmp);
    const code = await runCheck({
      platformDir: tmp,
      out: join(tmp, "custom.sqlite"),
      ci: true,
      json: true,
    });
    // Orphan fixture → exit 1.
    expect(code).toBe(1);
  });
});

describe("spec check — --ci force-rebuild semantics", () => {
  test("--ci on a directory with no prior DB does not throw", async () => {
    makeOrphanFixture(tmp);
    // First run: no DB exists yet. --ci's existsSync guards each rmSync,
    // so this should succeed and produce an ORPHAN_REQ → exit 1.
    const code = await runCheck({ platformDir: tmp, ci: true, json: true });
    expect(code).toBe(1);
    // stderr contains the "cold-reset prior index" log.
    expect(errs.some((m) => m.includes("cold-reset prior index state"))).toBe(true);
  });
});

describe("spec check — JSON output is parseable", () => {
  test("--json emits a JSON array; orphan fixture has exactly one row (ORPHAN_REQ)", async () => {
    makeOrphanFixture(tmp);
    const code = await runCheck({ platformDir: tmp, ci: true, json: true });
    expect(code).toBe(1);
    // The JSON output is the only stdout line in --json mode (build_id
    // is skipped) — but scan for it explicitly rather than trusting
    // logs[0]. If a stray console.log lands ahead of the JSON, the old
    // `JSON.parse(logs[0])` shape failed with a confusing SyntaxError;
    // this filter fails with a clear `expect(jsonLine).toBeDefined()`
    // instead, pointing at the real defect.
    const jsonLine = logs.find((l) => l.startsWith("[") || l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      code: "ORPHAN_REQ",
      req_id: "TEST-001",
      repo: null,
      severity: "error",
    });
    // build_id chrome is suppressed in --json mode.
    expect(logs.every((l) => !l.startsWith("build_id:"))).toBe(true);
  });
});

describe("spec check — exit code wiring", () => {
  test("exit 1 when any error-severity diagnostic exists (orphan fixture)", async () => {
    makeOrphanFixture(tmp);
    const code = await runCheck({ platformDir: tmp, ci: true, json: true });
    expect(code).toBe(1);
  });

  test("exit 0 when 0 diagnostics (clean fixture: implements + verifies tags)", async () => {
    makeCleanFixture(tmp);
    const code = await runCheck({ platformDir: tmp, ci: true, json: true });
    // 0 diagnostics → exit 0. JSON output is `[]`. Scan for the JSON
    // line explicitly so a stray debug log ahead of it produces a clear
    // "jsonLine is undefined" failure rather than a misleading parse
    // mismatch (WR-02 review-fix).
    expect(code).toBe(0);
    const jsonLine = logs.find((l) => l.startsWith("[") || l.startsWith("{"));
    expect(jsonLine).toBe("[]");
  });

  // WR-05 regression: a crash inside the pipeline (anywhere between
  // openStorage and renderDiagnostics) MUST exit 2, not citty's default
  // exit 1. Distinguishing crash from "expected error-severity
  // diagnostics" is what the inverted CI assertion relies on — if a
  // crash happens to also exit 1, the gate silently false-greens.
  //
  // The no-spec-engine/ input now throws NotASpecPlatformError, which the
  // command boundary catches → friendly message (no "crashed:" / no stack
  // trace) + exit 2. The exit-2 invariant the inverted CI assertion relies
  // on is preserved; only the message shape changed (260605-g84 B.2).
  test("exit 2 with friendly message when platformDir is not a Spec Engine platform (no spec-engine/)", async () => {
    // tmp exists but is empty — no spec-engine/ → NotASpecPlatformError.
    const code = await runCheck({ platformDir: tmp, ci: true, json: true });
    expect(code).toBe(2);
    // Friendly, actionable message — NOT a raw crash/stack trace.
    expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(true);
    expect(errs.some((m) => m.includes("spec map fixtures/platform-fixture"))).toBe(true);
    // No leaked internals: neither the "crashed:" prefix nor the old
    // discoverRepos: string nor stack frames.
    expect(errs.some((m) => m.includes("spec check: crashed:"))).toBe(false);
    expect(errs.some((m) => m.includes("discoverRepos:"))).toBe(false);
  });

  // Follow-up fix (260605-g84): assertSpecPlatform runs BEFORE
  // mkdirSync(.spec-engine)/--ci rm/openStorage, so a non-platform dir throws
  // → exit 2 and leaves NO .spec-engine/ artifact. Idempotent across runs.
  test("non-platform dir leaves NO .spec-engine/ artifact and is idempotent (1st === 2nd run)", async () => {
    // 1st run (no --ci): exit 2 + friendly message + NO artifact.
    const first = await runCheck({ platformDir: tmp });
    expect(first).toBe(2);
    expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(true);
    expect(existsSync(join(tmp, ".spec-engine"))).toBe(false);

    // 2nd run against the SAME dir: identical exit 2 + identical message,
    // still NO artifact (no stale empty index can have been written to
    // poison this run). 1st === 2nd.
    errs.length = 0;
    logs.length = 0;
    const second = await runCheck({ platformDir: tmp });
    expect(second).toBe(2);
    expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(true);
    expect(existsSync(join(tmp, ".spec-engine"))).toBe(false);
  });
});

describe("spec check — warning-severity exit-code branch (DIAG-02)", () => {
  test("warning-only diagnostics exit 0 (first ever exercise of severity==='warning' branch)", async () => {
    makeWarningOnlyFixture(tmp);
    const code = await runCheck({ platformDir: tmp, ci: true, json: true });
    expect(code).toBe(0);
    // JSON output is a single-row array with the NO_SPEC_CONFIG warning.
    // Scan for the JSON line (WR-02 review-fix) rather than trusting logs[0].
    const jsonLine = logs.find((l) => l.startsWith("[") || l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const got = JSON.parse(jsonLine as string) as Array<{ code: string; severity: string }>;
    expect(got.length).toBe(1);
    expect(got[0]?.code).toBe("NO_SPEC_CONFIG");
    expect(got[0]?.severity).toBe("warning");
  });

  test("mixed error+warning diagnostics exit 1 (error branch dominates)", async () => {
    makeMixedFixture(tmp);
    const code = await runCheck({ platformDir: tmp, ci: true, json: true });
    expect(code).toBe(1);
    // Scan for the JSON line (WR-02 review-fix) rather than trusting logs[0].
    const jsonLine = logs.find((l) => l.startsWith("[") || l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const got = JSON.parse(jsonLine as string) as Array<{ code: string; severity: string }>;
    const severities = got.map((d) => d.severity).sort();
    expect(severities).toContain("error");
    expect(severities).toContain("warning");
  });
});

// ----------------------------------------------------------------------------
// RED-14 dead-end audit: the generic crash branch (catch-all → "spec check:
// crashed:" + exit 2) existed without a covering test.
// ----------------------------------------------------------------------------

describe("spec check — generic crash branch (RED-14)", () => {
  test("openStorage failure (--out points at an existing directory) → exit 2 'crashed'", async () => {
    makeOrphanFixture(tmp);
    // A DIRECTORY at the db path: passes the containment guard (inside
    // platformDir) but openStorage cannot open a directory as SQLite —
    // the throw must land in the catch-all, NOT citty's default handling.
    mkdirSync(join(tmp, "dbdir"), { recursive: true });
    const code = await runCheck({ platformDir: tmp, out: "dbdir" });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("spec check: crashed:");
  });
});

// ----------------------------------------------------------------------------
// --unsourced-change (USRC-01..04): the two-layer off-by-default guarantee.
//
// Layer 1 (citty): the flag has NO `default:` key, so its absence yields
// `undefined`. Layer 2 (run body): the emission is gated behind an explicit
// `if (args.unsourcedChange)` enabled-check. These cases lock BOTH the
// flag-off (zero rows) and flag-on (exactly one row for BILLING-001) paths,
// the warning severity, and that the warning never flips the exit code.
//
// All runs operate against a cloneFixture() of the canonical fixture so the
// command's `.spec-engine/` artifact lands in the clone's tree, never in
// fixtures/platform-fixture/ (D-08-adjacent read-only invariant).
// ----------------------------------------------------------------------------

/** Scan the captured stdout for the JSON diagnostic array (the only `[`/`{`
 *  line in --json mode — build_id chrome is suppressed). Parses + returns the
 *  rows. Mirrors the scan idiom used throughout this file. */
function parseDiagnostics(): Array<{
  code: string;
  repo: string | null;
  req_id: string | null;
  severity: string;
}> {
  const jsonLine = logs.find((l) => l.startsWith("[") || l.startsWith("{"));
  expect(jsonLine).toBeDefined();
  return JSON.parse(jsonLine as string);
}

describe("spec check — --unsourced-change (USRC-01..04)", () => {
  test("flag OFF (omitted) → ZERO UNSOURCED_CHANGE rows against the canonical fixture", async () => {
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);
    // No `unsourcedChange` key at all — citty boolean-without-default reads
    // as undefined; the run-body guard treats it as off (layer 1 + layer 2).
    const code = await runCheck({ platformDir: cloned, ci: true, json: true });
    expect(code).toBe(1); // the planted error-severity rows still fire.
    const got = parseDiagnostics();
    const unsourced = got.filter((d) => d.code === "UNSOURCED_CHANGE");
    expect(unsourced).toHaveLength(0);
  });

  test("flag explicitly false → ZERO UNSOURCED_CHANGE rows (layer-2 guard treats false === off)", async () => {
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);
    const code = await runCheck({
      platformDir: cloned,
      ci: true,
      json: true,
      unsourcedChange: false,
    });
    expect(code).toBe(1);
    const got = parseDiagnostics();
    expect(got.filter((d) => d.code === "UNSOURCED_CHANGE")).toHaveLength(0);
  });

  test("NON-CI flag OFF (no --ci, no flag) → ZERO UNSOURCED_CHANGE rows (USRC-02 plain `spec check`)", async () => {
    // USRC-02 names BOTH surfaces: `spec check` AND `spec check --ci` must
    // emit zero rows without the flag. The other off-by-default cases all run
    // with ci:true; this locks the plain (non-CI) `spec check` path too. The
    // --ci flag only governs the pre-index cold-rebuild rm — it does not gate
    // the unsourced emission — so off-by-default must hold identically here.
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);
    const code = await runCheck({ platformDir: cloned, json: true });
    expect(code).toBe(1); // planted error-severity rows still fire.
    const got = parseDiagnostics();
    expect(got.filter((d) => d.code === "UNSOURCED_CHANGE")).toHaveLength(0);
  });

  test("NON-CI flag ON (no --ci, --unsourced-change) → exactly ONE BILLING-001 warning (USRC-01/02 plain `spec check`)", async () => {
    // The opt-in must behave identically on the plain `spec check` surface:
    // exactly one warning-severity UNSOURCED_CHANGE row for the BILLING-001
    // supersession that lacks a supersedes-via issue, without --ci.
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);
    const code = await runCheck({ platformDir: cloned, json: true, unsourcedChange: true });
    expect(code).toBe(1); // warning never flips the exit; planted errors drive it.
    const got = parseDiagnostics();
    const unsourced = got.filter((d) => d.code === "UNSOURCED_CHANGE");
    expect(unsourced).toHaveLength(1);
    expect(unsourced[0]?.repo).toBe(null);
    expect(unsourced[0]?.req_id).toBe("BILLING-001");
    expect(unsourced[0]?.severity).toBe("warning");
  });

  test("flag ON → exactly ONE UNSOURCED_CHANGE row {repo:null, BILLING-001} (locks A3 / OQ1)", async () => {
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);
    const code = await runCheck({
      platformDir: cloned,
      ci: true,
      json: true,
      unsourcedChange: true,
    });
    // Warning-only addition does not change the exit code — the pre-existing
    // error-severity rows still drive exit 1 (USRC-03).
    expect(code).toBe(1);
    const got = parseDiagnostics();
    const unsourced = got
      .filter((d) => d.code === "UNSOURCED_CHANGE")
      .map((d) => ({ code: d.code, repo: d.repo, req_id: d.req_id }));
    // EXACT set/count — not `> 0`. The canonical fixture's BILLING-001 is the
    // only Superseded requirement lacking a supersedes-via issue.
    expect(unsourced).toEqual([{ code: "UNSOURCED_CHANGE", repo: null, req_id: "BILLING-001" }]);
  });

  test("flag ON → the flagged UNSOURCED_CHANGE row has severity 'warning'", async () => {
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);
    await runCheck({ platformDir: cloned, ci: true, json: true, unsourcedChange: true });
    const got = parseDiagnostics();
    const row = got.find((d) => d.code === "UNSOURCED_CHANGE");
    expect(row).toBeDefined();
    expect(row?.severity).toBe("warning");
  });

  test("flag ON adds exactly the 1 UNSOURCED_CHANGE row on top of the baseline set", async () => {
    // flag-off run captures the baseline count.
    const offClone = cloneFixture(FIXTURE);
    clones.push(offClone);
    await runCheck({ platformDir: offClone, ci: true, json: true });
    const offCount = parseDiagnostics().length;

    logs.length = 0;
    errs.length = 0;

    // flag-on run: same fixture content, +1 UNSOURCED_CHANGE row.
    const onClone = cloneFixture(FIXTURE);
    clones.push(onClone);
    await runCheck({ platformDir: onClone, ci: true, json: true, unsourcedChange: true });
    const onRows = parseDiagnostics();
    expect(onRows.length).toBe(offCount + 1);
    expect(onRows.filter((d) => d.code === "UNSOURCED_CHANGE")).toHaveLength(1);
  });

  test("warning row does NOT flip the exit code — flag-on / flag-off exit codes are equal (USRC-03)", async () => {
    const offClone = cloneFixture(FIXTURE);
    clones.push(offClone);
    const offCode = await runCheck({ platformDir: offClone, ci: true, json: true });

    logs.length = 0;
    errs.length = 0;

    const onClone = cloneFixture(FIXTURE);
    clones.push(onClone);
    const onCode = await runCheck({
      platformDir: onClone,
      ci: true,
      json: true,
      unsourcedChange: true,
    });
    // The warning row composes with the unchanged `severity === "error"`
    // predicate — it never changes the exit code.
    expect(onCode).toBe(offCode);
  });
});
