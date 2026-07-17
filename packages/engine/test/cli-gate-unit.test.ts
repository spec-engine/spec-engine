// packages/engine/test/cli-gate-unit.test.ts
//
// Phase 06 Plan 04 Task 1 — in-process CLI tests for `spec gate`
// (commands/gate.ts). Locks GATE-01 (PASS) + GATE-02 (NOT_FOUND, DRAFT,
// SUPERSEDED, VERSION_PIN) at the citty seam, plus the edge cases that
// distinguish the gate from a single-decision branch:
//
//   - Pitfall 8 / T-06-03-05: unknown repo → exit 2 with "unknown repo"
//     on stderr; NEVER conflated with NOT_FOUND.
//   - T-06-03-01 / V12: --out outside platformDir → exit 2 with
//     "must be inside platformDir".
//   - T-06-03-04: empty / whitespace repo or reqId → exit 2.
//   - RESEARCH Open Q4: text mode appends `build_id: <hash>` tail;
//     JSON mode does NOT emit `build_id:` (keeps stdout jq-parsable).
//
// DRAFT and VERSION_PIN coverage uses cloneFixture-mutation rather than
// a canonical fixture plant — this preserves CHCK-04's inverted CI
// assertion untouched. Each mutation is documented inline next to the
// test that performs it.
//
// Harness pattern mirrors cli-resolve-unit.test.ts: ExitError class,
// beforeEach/afterEach stubs over console.log + console.error +
// process.exit, RunFn cast over gateCommand, runGate helper returning
// the exit code.
//
// WR-06 invariant (T-06-04-01): every test calls cloneFixture(FIXTURE)
// in beforeEach. afterEach rmSync's the clone. fixtures/platform-fixture/
// is NEVER mutated by this file — verified post-suite via
// `git status fixtures/platform-fixture/`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  // WR-06: clone the canonical fixture into a fresh tmpdir per test so
  // mutations + .spec-engine/ writes land outside the canonical tree.
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
  // Best-effort cleanup; ignore failures (tmpdir-bound, OS will reap).
  try {
    require("node:fs").rmSync(clone, { recursive: true, force: true });
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

/** Return the LAST stdout line that parses as JSON. The gate text-mode
 *  appends a `build_id: <hash>` line; the JSON outcome is emitted as
 *  the first stdout chunk. In JSON mode, the SOLE stdout line is the
 *  outcome — so logs.at(-1) is always the right pick. In text mode
 *  the caller asserts on the joined stdout instead. */
function lastLogAsJson<T = Record<string, unknown>>(): T {
  const last = logs.at(-1) ?? "";
  return JSON.parse(last) as T;
}

describe("spec gate (in-process)", () => {
  // ---------------------------------------------------------------------
  // T1 — PASS (GATE-01 happy path). api is pinned @2; BILLING-009 is
  // Active and changed_at_version=2 (it supersedes BILLING-001 in the
  // canonical spec). Pin >= changed_at → PASS.
  // ---------------------------------------------------------------------
  test("PASS: api BILLING-009 against canonical fixture (GATE-01)", async () => {
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(0);
    const out = lastLogAsJson<{
      pass: boolean;
      reason: string;
      pinned_spec_version: number;
      changed_at_version: number;
    }>();
    expect(out.pass).toBe(true);
    expect(out.reason).toBe("PASS");
    expect(out.pinned_spec_version).toBe(2);
    expect(out.changed_at_version).toBe(2);
  });

  // ---------------------------------------------------------------------
  // T2 — SUPERSEDED (GATE-02; ROADMAP Success Criterion #1). mobile is
  // pinned @1 and references BILLING-001 which is Superseded by
  // BILLING-009 in the canonical spec.
  // ---------------------------------------------------------------------
  test("SUPERSEDED: mobile BILLING-001 — detail names successor BILLING-009 (GATE-02)", async () => {
    const code = await runGate({
      repo: "mobile",
      reqId: "BILLING-001",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(1);
    const out = lastLogAsJson<{ reason: string; detail: string }>();
    expect(out.reason).toBe("SUPERSEDED");
    expect(out.detail).toContain("BILLING-009");
  });

  // ---------------------------------------------------------------------
  // T3 — NOT_FOUND: requirement id that doesn't exist in the canonical
  // spec. status field is explicit null per classifyGate's contract.
  // ---------------------------------------------------------------------
  test("NOT_FOUND: api BILLING-999 — status === null (GATE-02)", async () => {
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-999",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(1);
    const out = lastLogAsJson<{ reason: string; status: string | null }>();
    expect(out.reason).toBe("NOT_FOUND");
    expect(out.status).toBeNull();
  });

  // ---------------------------------------------------------------------
  // T4 — NOT_FOUND: a different non-existent id, demonstrating that
  // NOT_FOUND is exclusively the requirement-misses path (Pitfall 8).
  // ---------------------------------------------------------------------
  test("NOT_FOUND: api COMPLETELY-MADE-UP-1000 — proves NOT_FOUND is req-only (Pitfall 8)", async () => {
    const code = await runGate({
      repo: "api",
      reqId: "COMPLETELY-MADE-UP-1000",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(1);
    const out = lastLogAsJson<{ reason: string }>();
    expect(out.reason).toBe("NOT_FOUND");
  });

  // ---------------------------------------------------------------------
  // T5 — DRAFT via cloneFixture mutation (GATE-02). Flip BILLING-009's
  // status heading in the cloned BILLING/SPEC.md from "Active" to
  // "Draft". Canonical fixture is NOT touched.
  // ---------------------------------------------------------------------
  test("DRAFT: cloneFixture mutation flips BILLING-009 Active → Draft (GATE-02)", async () => {
    // cloneFixture mutation — structured status flip in the cloned
    // BILLING/SPEC.json ONLY (fixture migrated to JSON in 18-03). The canonical
    // fixture file under fixtures/platform-fixture/spec-engine/BILLING/SPEC.json
    // is never touched (WR-06 / T-06-04-01).
    const specPath = join(clone, "spec-engine", "BILLING", "SPEC.json");
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    const b9 = spec.requirements.find(
      (r: { id: string; status: string }) => r.id === "BILLING-009",
    );
    expect(b9?.status).toBe("active");
    b9.status = "draft";
    writeFileSync(specPath, JSON.stringify(spec, null, 2));

    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(1);
    const out = lastLogAsJson<{ reason: string }>();
    expect(out.reason).toBe("DRAFT");
  });

  // ---------------------------------------------------------------------
  // T6 — VERSION_PIN via cloneFixture mutation (GATE-02). Plant a new
  // BILLING-011 Active req in the cloned spec; the parser derives
  // changed_at_version=2 for a freshly-added req ONLY when it's part
  // of a supersession chain (see parser/spec.ts:240-248). To trigger
  // that branch we ALSO flip BILLING-002 to "Superseded by BILLING-011"
  // — that makes BILLING-011 the "new one in a recent supersession",
  // landing it at changed_at_version=spec_version=2. Then plant a tag
  // a BILLING-011 tag in a new file under mobile/src/ (mobile is
  // pinned @1 per spec-engine.member.json) so the member references the
  // new req. Result: req.changed_at_version=2 > pin=1 → VERSION_PIN.
  //
  // All mutations are scoped to `clone` — canonical untouched.
  // ---------------------------------------------------------------------
  test("VERSION_PIN: cloneFixture mutation adds BILLING-011@2 + mobile@1 tag (GATE-02)", async () => {
    // Fixture migrated to JSON in 18-03: mutate the structured envelope instead
    // of Markdown headings.
    const specPath = join(clone, "spec-engine", "BILLING", "SPEC.json");
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    const b2 = spec.requirements.find(
      (r: { id: string; status: string }) => r.id === "BILLING-002",
    );
    expect(b2?.status).toBe("active");

    // Mutation A: flip BILLING-002 active → superseded by BILLING-011 (this seeds
    // the supersededIds set so BILLING-011 lands at changed_at_version=
    // spec_version). Under the DERIVED domain version (SCHM-006, 1 + edge count),
    // the fixture already carries one edge (BILLING-001→009); this mutation adds
    // the second, so the derived version is 3 — BILLING-011 changes at @3.
    b2.status = "superseded";
    b2.supersededBy = "BILLING-011";

    // Mutation B: append a new active BILLING-011 to the same domain.
    spec.requirements.push({
      id: "BILLING-011",
      status: "active",
      statement: "Test-fixture for VERSION_PIN gate reason.",
      why: "Locks GATE-02 VERSION_PIN reason without disturbing the canonical fixture.",
      supersedes: null,
      supersededBy: null,
      relates: [],
      livesIn: ["test-version-pin.ts"],
      issues: [],
    });
    writeFileSync(specPath, JSON.stringify(spec, null, 2));

    // Mutation C: plant the member tag in mobile (pinned @1).
    const memberPath = join(clone, "mobile", "src", "test-version-pin.ts");
    writeFileSync(
      memberPath,
      `${specTag("BILLING-011")}export function testVersionPin() {\n  /* PoC */\n}\n`,
    );

    const code = await runGate({
      repo: "mobile",
      reqId: "BILLING-011",
      platformDir: clone,
      json: true,
    });
    // Debug aid: if the test would fail, print the parsed outcome so
    // the changed_at_version derivation is visible in test output.
    const out = lastLogAsJson<{
      reason: string;
      detail: string;
      changed_at_version: number;
      pinned_spec_version: number;
    }>();
    if (code !== 1 || out.reason !== "VERSION_PIN") {
      console.error(
        `T6 diagnostic: code=${code} reason=${out.reason} ` +
          `changed_at_version=${out.changed_at_version} pin=${out.pinned_spec_version} ` +
          `detail=${out.detail}`,
      );
    }
    expect(code).toBe(1);
    expect(out.reason).toBe("VERSION_PIN");
    expect(out.detail).toContain("@1"); // the pin
    expect(out.detail).toContain("@3"); // derived changed_at (1 + 2 edges)
    expect(out.changed_at_version).toBe(3);
  });

  // ---------------------------------------------------------------------
  // T7 — unknown repo → exit 2 (Pitfall 8 / T-06-03-05). Distinguishes
  // from NOT_FOUND which is reserved for the requirement-missing path.
  // ---------------------------------------------------------------------
  test("unknown repo → exit 2 with 'unknown repo' on stderr (Pitfall 8)", async () => {
    const code = await runGate({
      repo: "ghost-repo",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(2);
    const stderr = errs.join("\n");
    expect(stderr).toContain("unknown repo");
    expect(stderr).toContain("ghost-repo");
    // No stdout JSON outcome: the failure surface is stderr.
    expect(logs.length).toBe(0);
  });

  // ---------------------------------------------------------------------
  // T8 — V12 path-containment (T-06-03-01). --out outside platformDir
  // exits 2 with the canonical "must be inside platformDir" message.
  // ---------------------------------------------------------------------
  test("V12: --out outside platformDir → exit 2 with 'must be inside platformDir'", async () => {
    const evilOut = resolve(clone, "..", "evil.sqlite");
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      out: evilOut,
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/must be inside platformDir/);
  });

  // ---------------------------------------------------------------------
  // T9 — empty repo → exit 2 (T-06-03-04 input validation).
  // ---------------------------------------------------------------------
  test("empty repo → exit 2", async () => {
    const code = await runGate({
      repo: "",
      reqId: "BILLING-009",
      platformDir: clone,
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/<repo> and <reqId> are required/);
  });

  // ---------------------------------------------------------------------
  // T10 — whitespace-only reqId → exit 2 (T-06-03-04 trim guard).
  // ---------------------------------------------------------------------
  test("whitespace-only reqId → exit 2", async () => {
    const code = await runGate({
      repo: "api",
      reqId: "   ",
      platformDir: clone,
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/<repo> and <reqId> are required/);
  });

  // ---------------------------------------------------------------------
  // T11 — text mode emits `build_id: <hash>` tail (RESEARCH Open Q4 /
  // parity with check.ts:123-124).
  // ---------------------------------------------------------------------
  test("text mode appends build_id tail line (parity with check.ts)", async () => {
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: false,
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/^build_id: [0-9a-f]{64}$/m);
  });

  // ---------------------------------------------------------------------
  // T12 — JSON mode does NOT emit build_id (keeps stdout jq-parsable).
  // ---------------------------------------------------------------------
  test("JSON mode does NOT emit build_id (clean for jq)", async () => {
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).not.toContain("build_id:");
    // And the sole stdout line parses as the GateOutcome JSON object.
    expect(logs.length).toBe(1);
    const out = lastLogAsJson<{ pass: boolean }>();
    expect(out.pass).toBe(true);
  });

  // -------------------------------------------------------------------------
  // RED-14 dead-end audit: four gate seams existed without a covering test —
  // the RED-11 not-a-platform exit, the advisory missing-manifest warning,
  // and the WR-03 EPIPE-tolerance paths (swallow EPIPE-shaped write errors;
  // crash on anything else).
  // -------------------------------------------------------------------------

  test("non-platform dir → friendly RED-11 message + exit 2 (RED-14)", async () => {
    const bare = mkdtempSync(join(tmpdir(), "spec-gate-bare-"));
    try {
      const code = await runGate({ repo: "api", reqId: "BILLING-009", platformDir: bare });
      expect(code).toBe(2);
      expect(errs.join("\n")).toContain("is not a Spec Engine platform yet");
      // The guard runs BEFORE mkdir/cold-rm — no .spec-engine/ artifact minted.
      expect(existsSync(join(bare, ".spec-engine"))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("no spec-engine.platform.json → zero manifest chrome, gate still runs (RED-85)", async () => {
    // The manifest is retired: its absence is the NORMAL state, so the old
    // RED-14 "is missing" advisory must never resurface — the platform
    // version is derived from the domain SPEC.json files inside discoverRepos.
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect([0, 1]).toContain(code);
    expect(errs.join("\n")).not.toContain("spec-engine.platform.json");
  });

  test("WR-03: EPIPE-shaped stdout write failures are swallowed — gate still exits 0 (RED-14)", async () => {
    // Simulate `spec gate ... | head -1`: the member closed stdout, so
    // BOTH text-mode writes (decision line + build_id tail) throw EPIPE.
    console.log = () => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    };
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: false,
    });
    expect(code).toBe(0);
  });

  test("WR-03: ERR_STREAM_DESTROYED is treated as EPIPE-shaped (RED-14)", async () => {
    console.log = () => {
      throw Object.assign(new Error("stream destroyed"), { code: "ERR_STREAM_DESTROYED" });
    };
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(0);
  });

  test("WR-03: a NON-EPIPE stdout failure still crashes with exit 2 (RED-14)", async () => {
    // A primitive throw exercises isEpipe's non-object guard; the rethrow
    // must land in the outer catch → "crashed" + exit 2, NOT exit 0/1.
    console.log = () => {
      // The non-Error throw shape IS the case under test (isEpipe's
      // non-object guard).
      throw "stdout exploded";
    };
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("spec gate: crashed:");
  });
});
