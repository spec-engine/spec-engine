// @spec CHCK-025

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cloneFixture } from "../testing/cloneFixture";
import { TestPlatform } from "../testing/platform";
import { specTag } from "../testing/specTag";
import { checkCommand } from "./check";

// Read-only across the suite: every mutating run works on a cloneFixture() copy.
const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

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
    return -1;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

/** One Active requirement, no members, no tags: exactly one ORPHAN_REQ. */
async function makeOrphanFixture(root: string): Promise<void> {
  const domain = await TestPlatform.at(root).domain("TEST", { owner: "drea" });
  await domain.req({
    statement: "Orphan req for the unit test.",
    why: "Drives an ORPHAN_REQ diagnostic.",
  });
}

async function makeCleanFixture(root: string): Promise<void> {
  const fx = TestPlatform.at(root);
  const domain = await fx.domain("TEST", { owner: "drea" });
  await domain.req({
    statement: "Clean req — tagged by src AND test.",
    why: "Drives 0 diagnostics.",
  });
  await fx.member("member", {
    files: {
      "src/feature.ts": `${specTag("TEST-001")}export const x = 1;\n`,
      "test/feature.test.ts": `${specTag("TEST-001")}export const y = 2;\n`,
    },
  });
}

/** One NO_SPEC_CONFIG warning and nothing else: no requirements, no ORPHAN_REQ. */
function makeWarningOnlyFixture(root: string): void {
  TestPlatform.at(root).unpinned("strangers");
}

async function makeMixedFixture(root: string): Promise<void> {
  await makeOrphanFixture(root);
  makeWarningOnlyFixture(root);
}

describe("spec check — path-containment guard", () => {
  test("--out resolving outside platformDir rejects with exit 2", async () => {
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
    await makeOrphanFixture(tmp);
    const code = await runCheck({
      platformDir: tmp,
      out: join(tmp, "custom.sqlite"),
      ci: true,
      json: true,
    });
    expect(code).toBe(1);
  });
});

describe("spec check — --ci force-rebuild semantics", () => {
  test("--ci on a directory with no prior DB does not throw", async () => {
    await makeOrphanFixture(tmp);
    const code = await runCheck({ platformDir: tmp, ci: true, json: true });
    expect(code).toBe(1);
    expect(errs.some((m) => m.includes("cold-reset prior index state"))).toBe(true);
  });
});

describe("spec check — JSON output is parseable", () => {
  test("--json emits a JSON array; orphan fixture has exactly one row (ORPHAN_REQ)", async () => {
    await makeOrphanFixture(tmp);
    const code = await runCheck({ platformDir: tmp, ci: true, json: true });
    expect(code).toBe(1);
    // Scanned rather than read from logs[0], so a stray console.log ahead of
    // the JSON fails on toBeDefined, not with a confusing SyntaxError.
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
    expect(logs.every((l) => !l.startsWith("build_id:"))).toBe(true);
  });
});

describe("spec check — exit code wiring", () => {
  test("exit 1 when any error-severity diagnostic exists (orphan fixture)", async () => {
    await makeOrphanFixture(tmp);
    const code = await runCheck({ platformDir: tmp, ci: true, json: true });
    expect(code).toBe(1);
  });

  test("exit 0 when 0 diagnostics (clean fixture: implements + verifies tags)", async () => {
    await makeCleanFixture(tmp);
    const code = await runCheck({ platformDir: tmp, ci: true, json: true });
    expect(code).toBe(0);
    const jsonLine = logs.find((l) => l.startsWith("[") || l.startsWith("{"));
    expect(jsonLine).toBe("[]");
  });

  // A crash must exit 2, never 1: the inverted CI assertion tells a crash
  // from error-severity diagnostics by exit code, and a crash that exits 1
  // would false-green the gate.
  test("exit 2 with friendly message when platformDir is not a Spec Engine platform (no spec-engine/)", async () => {
    const code = await runCheck({ platformDir: tmp, ci: true, json: true });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(true);
    expect(errs.some((m) => m.includes("spec map fixtures/platform-fixture"))).toBe(true);
    expect(errs.some((m) => m.includes("spec check: crashed:"))).toBe(false);
    expect(errs.some((m) => m.includes("discoverRepos:"))).toBe(false);
  });

  test("non-platform dir leaves NO .spec-engine/ artifact and is idempotent (1st === 2nd run)", async () => {
    const first = await runCheck({ platformDir: tmp });
    expect(first).toBe(2);
    expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(true);
    expect(existsSync(join(tmp, ".spec-engine"))).toBe(false);

    errs.length = 0;
    logs.length = 0;
    const second = await runCheck({ platformDir: tmp });
    expect(second).toBe(2);
    expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(true);
    expect(existsSync(join(tmp, ".spec-engine"))).toBe(false);
  });
});

describe("spec check — warning-severity exit-code branch", () => {
  test("warning-only diagnostics exit 0", async () => {
    makeWarningOnlyFixture(tmp);
    const code = await runCheck({ platformDir: tmp, ci: true, json: true });
    expect(code).toBe(0);
    const jsonLine = logs.find((l) => l.startsWith("[") || l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const got = JSON.parse(jsonLine as string) as Array<{ code: string; severity: string }>;
    expect(got.length).toBe(1);
    expect(got[0]?.code).toBe("NO_SPEC_CONFIG");
    expect(got[0]?.severity).toBe("warning");
  });

  test("mixed error+warning diagnostics exit 1 (error branch dominates)", async () => {
    await makeMixedFixture(tmp);
    const code = await runCheck({ platformDir: tmp, ci: true, json: true });
    expect(code).toBe(1);
    const jsonLine = logs.find((l) => l.startsWith("[") || l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const got = JSON.parse(jsonLine as string) as Array<{ code: string; severity: string }>;
    const severities = got.map((d) => d.severity).sort();
    expect(severities).toContain("error");
    expect(severities).toContain("warning");
  });
});

describe("spec check — generic crash branch", () => {
  test("openStorage failure (--out points at an existing directory) → exit 2 'crashed'", async () => {
    await makeOrphanFixture(tmp);
    // A directory at the db path passes the containment guard but cannot be
    // opened as SQLite.
    mkdirSync(join(tmp, "dbdir"), { recursive: true });
    const code = await runCheck({ platformDir: tmp, out: "dbdir" });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("spec check: crashed:");
  });
});

// --unsourced-change is off by default twice over: the citty flag has no
// `default:` key, and the run body gates the emission on an explicit check.
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

describe("spec check — --unsourced-change", () => {
  test("flag OFF (omitted) → ZERO UNSOURCED_CHANGE rows against the canonical fixture", async () => {
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);
    const code = await runCheck({ platformDir: cloned, ci: true, json: true });
    expect(code).toBe(1);
    const got = parseDiagnostics();
    const unsourced = got.filter((d) => d.code === "UNSOURCED_CHANGE");
    expect(unsourced).toHaveLength(0);
  });

  test("flag explicitly false → ZERO UNSOURCED_CHANGE rows", async () => {
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

  test("NON-CI flag OFF (no --ci, no flag) → ZERO UNSOURCED_CHANGE rows on plain `spec check`", async () => {
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);
    const code = await runCheck({ platformDir: cloned, json: true });
    expect(code).toBe(1);
    const got = parseDiagnostics();
    expect(got.filter((d) => d.code === "UNSOURCED_CHANGE")).toHaveLength(0);
  });

  test("NON-CI flag ON (no --ci, --unsourced-change) → exactly ONE BILLING-001 warning on plain `spec check`", async () => {
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);
    const code = await runCheck({ platformDir: cloned, json: true, unsourcedChange: true });
    expect(code).toBe(1);
    const got = parseDiagnostics();
    const unsourced = got.filter((d) => d.code === "UNSOURCED_CHANGE");
    expect(unsourced).toHaveLength(1);
    expect(unsourced[0]?.repo).toBe(null);
    expect(unsourced[0]?.req_id).toBe("BILLING-001");
    expect(unsourced[0]?.severity).toBe("warning");
  });

  test("flag ON → exactly ONE UNSOURCED_CHANGE row {repo:null, BILLING-001}", async () => {
    const cloned = cloneFixture(FIXTURE);
    clones.push(cloned);
    const code = await runCheck({
      platformDir: cloned,
      ci: true,
      json: true,
      unsourcedChange: true,
    });
    expect(code).toBe(1);
    const got = parseDiagnostics();
    const unsourced = got
      .filter((d) => d.code === "UNSOURCED_CHANGE")
      .map((d) => ({ code: d.code, repo: d.repo, req_id: d.req_id }));
    // BILLING-001 is the fixture's only Superseded requirement lacking a
    // supersedes-via issue.
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
    const offClone = cloneFixture(FIXTURE);
    clones.push(offClone);
    await runCheck({ platformDir: offClone, ci: true, json: true });
    const offCount = parseDiagnostics().length;

    logs.length = 0;
    errs.length = 0;

    const onClone = cloneFixture(FIXTURE);
    clones.push(onClone);
    await runCheck({ platformDir: onClone, ci: true, json: true, unsourcedChange: true });
    const onRows = parseDiagnostics();
    expect(onRows.length).toBe(offCount + 1);
    expect(onRows.filter((d) => d.code === "UNSOURCED_CHANGE")).toHaveLength(1);
  });

  test("warning row does NOT flip the exit code — flag-on / flag-off exit codes are equal", async () => {
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
    expect(onCode).toBe(offCode);
  });
});
