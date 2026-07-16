// packages/engine/test/gate-cold-rebuild.test.ts
//
// Phase 06 Plan 04 Task 2 — GATE-03 invariant ("correctness over cache")
// locked at the CLI seam. Two tests:
//
//   CR1 — mutating canonical spec between two gate invocations is
//         observed WITHOUT a manual reindex step in between. Proves the
//         cold reset in commands/gate.ts:134-137 is unconditional
//         (T-06-04-03 / Pitfall: warm-DB blindness would silently mask
//         a Active→Draft flip).
//
//   CR2 — a pre-poisoned DB row that no scan input could produce is
//         nuked by the next gate invocation. The poison row is
//         `name="poisoned-ghost-repo", path="/dev/null", pin=999` (no
//         spec-engine.member.json discovery could materialize this shape).
//         After running gate against the poisoned name, gate exits 2
//         with "unknown repo" — proving the rm trio fired and the
//         poison row was wiped (otherwise the row would resolve and
//         gate would proceed to classifyGate, returning NOT_FOUND or
//         PASS instead of the unknown-repo exit-2 branch).
//
// Mirrors the harness pattern from cli-resolve-unit.test.ts (ExitError,
// stub console.log/error/exit, RunFn cast).
//
// This test file is allowed to depend on storage helpers (poisonRepoRow,
// listRepoNamesFromDb) — the D-08 grep-fence covers packages/engine/src,
// not packages/engine/test. We use the helpers rather than a raw
// `import { Database } from "bun:sqlite"` because the canonical
// cold-rebuild analog (check-ci-cold-rebuild.test.ts:31) goes through
// the helpers; matching that posture keeps the bun:sqlite surface
// confined to storage/sqlite.ts as Phase 1 mandated.
//
// WR-06 invariant (T-06-04-01): every test calls cloneFixture(FIXTURE)
// in beforeEach. afterEach rmSync's the clone. fixtures/platform-fixture/
// is NEVER mutated.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gateCommand } from "../src/commands/gate";
import { listRepoNamesFromDb, poisonRepoRow } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let dbPath: string;
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
  dbPath = join(clone, ".spec-engine", "index.sqlite");
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

describe("spec gate cold-rebuild invariant (GATE-03)", () => {
  // ---------------------------------------------------------------------
  // CR1 — T-06-04-03: spec mutation between two gate runs is observed
  // without a manual reindex. The first run returns PASS; we then flip
  // BILLING-009 from Active to Draft on disk in the SAME clone, and
  // re-run gate WITHOUT calling runIndex by hand. The cold reset in
  // commands/gate.ts must fire and re-index from spec, so the second
  // run reports DRAFT.
  // ---------------------------------------------------------------------
  test("CR1: spec mutation observed without manual reindex (Active → DRAFT)", async () => {
    // Step 1: first run against the unmutated clone — PASS.
    const code1 = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code1).toBe(0);
    const out1 = lastLogAsJson<{ reason: string }>();
    const reason1 = out1.reason;
    expect(reason1).toBe("PASS");

    // Step 2: mutate the spec — flip BILLING-009 active → draft. Fixture
    // migrated to JSON in 18-03: structured status flip, not a Markdown replace.
    const specPath = join(clone, "spec-engine", "BILLING", "SPEC.json");
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    const b9 = spec.requirements.find(
      (r: { id: string; status: string }) => r.id === "BILLING-009",
    );
    expect(b9?.status).toBe("active");
    b9.status = "draft";
    writeFileSync(specPath, JSON.stringify(spec, null, 2));

    // Clear logs/errs so the second run's stdout/stderr is read cleanly.
    logs.length = 0;
    errs.length = 0;

    // Step 3: second run — NO manual reindex. The cold reset inside
    // commands/gate.ts must wipe the prior DB and re-index from the
    // mutated spec; result MUST be DRAFT, not the stale PASS.
    const code2 = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code2).toBe(1);
    const out2 = lastLogAsJson<{ reason: string }>();
    const reason2 = out2.reason;
    expect(reason2).toBe("DRAFT");

    // Defensive: the two reasons MUST differ. If a future "optimization"
    // gates the rm trio on a stale flag, this assertion catches the
    // identity-stub regression in one line.
    expect(reason1).not.toBe(reason2);
  });

  // ---------------------------------------------------------------------
  // CR2 — T-06-04-02: pre-poisoned DB row is wiped before classifier
  // reads. We warm the DB via a benign gate run, INSERT a poison row
  // (name="poisoned-ghost-repo", path="/dev/null", pin=999 — a shape no
  // spec-engine.member.json discovery could produce), then run gate against
  // the poisoned name. Gate MUST exit 2 with "unknown repo" — that
  // signal proves the cold reset fired and the poison was nuked
  // BEFORE storage.getRepo() ran.
  //
  // If the rm trio were skipped, the poison row would survive into the
  // post-rm DB (or, more precisely, would survive the open without ever
  // being rm'd) and storage.getRepo("poisoned-ghost-repo") would return
  // a real-looking row, routing gate into classifyGate which would
  // return NOT_FOUND (the req exists; the repo lookup succeeds) — that
  // would be exit 1, NOT exit 2.
  // ---------------------------------------------------------------------
  test("CR2: pre-poisoned DB row is wiped before classifier reads", async () => {
    // Step 1: warm the DB with a real run so the file + schema exist
    // for the poison INSERT.
    const code0 = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code0).toBe(0);

    // Step 2: poison the DB. The helper goes through bun:sqlite inside
    // storage/sqlite.ts (D-08 fence), keeping the bun:sqlite surface
    // out of the test file.
    poisonRepoRow(dbPath, "poisoned-ghost-repo");

    // Confirm poison landed (pre-state probe).
    const namesAfterPoison = listRepoNamesFromDb(dbPath);
    expect(namesAfterPoison).toContain("poisoned-ghost-repo");

    // Clear logs/errs so the second-run captures are clean.
    logs.length = 0;
    errs.length = 0;

    // Step 3: invoke gate against the poisoned name. The cold reset
    // MUST fire, wiping the poison; then runIndex repopulates from the
    // real spec-engine.member.json discovery (which has no such repo); then
    // storage.getRepo("poisoned-ghost-repo") returns null; then the
    // unknown-repo screen at commands/gate.ts:161-170 exits 2.
    const code1 = await runGate({
      repo: "poisoned-ghost-repo",
      reqId: "BILLING-009",
      platformDir: clone,
    });
    expect(code1).toBe(2);
    expect(errs.join("\n")).toContain("unknown repo");

    // Belt-and-suspenders: the poison row is gone post-gate. If it
    // survived, the test above would already be wrong (gate would have
    // exited 1 with NOT_FOUND or 0 with PASS depending on which req
    // row landed). This is the explicit post-state probe.
    const namesAfterGate = listRepoNamesFromDb(dbPath);
    expect(namesAfterGate).not.toContain("poisoned-ghost-repo");
  });
});
