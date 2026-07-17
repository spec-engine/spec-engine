// packages/engine/test/cli-query-unit.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec QURY-001
//
// Unit tests for `spec query` (commands/query.ts). In-process invocation
// of the citty command with process.exit stubbed to throw ExitError so the
// test runner can assert on the exit code without terminating.
//
// Scope: COMMAND-level behavior — empty-text guard, V12 path-containment,
// FTS5 grammar-error stderr path, --limit parsing (non-integer / zero /
// >1000 / truncation), JSON shape against the canonical fixture trace,
// and text-mode column headers. The storage-seam fixture trace is locked
// separately in fts.test.ts (plan 04-03); this file locks the CLI surface
// for QURY-01 + QURY-02.
//
// Mirrors the harness pattern from cli-check-unit.test.ts /
// cli-propagation-unit.test.ts (ExitError, beforeEach stub block, RunFn
// cast). Tests that touch the platform fixture use cloneFixture (WR-06) so
// fixtures/platform-fixture/ is never mutated.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { queryCommand } from "../src/commands/query";
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
const queryRun = (queryCommand as unknown as { run: RunFn }).run;

async function runQuery(args: Record<string, unknown>): Promise<number> {
  try {
    await queryRun({ args, rawArgs: [] });
    // Success path: commands/query.ts does not call process.exit on
    // success — citty exits 0 on normal return. Mirror cli-propagation.
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

describe("spec query (in-process)", () => {
  test("empty text exits 2 with usage message", async () => {
    const code = await runQuery({ text: "" });
    expect(code).toBe(2);
    expect(errs[0] ?? "").toMatch(/spec query: <text> is required/);
  });

  test("QURY-02 acceptance: 'renewal charge' returns BILLING-009 as top hit (--json)", async () => {
    // Empirical end-to-end QURY-02 lock at the CLI surface. The storage-
    // level claim (porter stemming: renewal ↔ renews) is locked in
    // plan 04-03's fts.test.ts; this test confirms the citty surface
    // surfaces it byte-for-byte.
    const code = await runQuery({
      text: "renewal charge",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(logs[0] ?? "[]");
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]?.req_id).toBe("BILLING-009");
  });

  test("FTS5 grammar error exits 2 with friendly stderr message", async () => {
    const code = await runQuery({ text: "AND OR", platformDir: clone });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/spec query: FTS5 query syntax error/);
  });

  test("--limit non-integer exits 2", async () => {
    const code = await runQuery({
      text: "renewal charge",
      platformDir: clone,
      limit: "abc",
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/--limit must be a positive integer/);
  });

  test("--limit zero exits 2", async () => {
    const code = await runQuery({
      text: "renewal charge",
      platformDir: clone,
      limit: "0",
    });
    expect(code).toBe(2);
  });

  test("--limit above 1000 exits 2", async () => {
    const code = await runQuery({
      text: "renewal charge",
      platformDir: clone,
      limit: "2000",
    });
    expect(code).toBe(2);
  });

  test("--limit 1 truncates result set", async () => {
    const code = await runQuery({
      text: "subscription",
      platformDir: clone,
      limit: "1",
      json: true,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(logs[0] ?? "[]");
    expect(parsed.length).toBeLessThanOrEqual(1);
  });

  test("V12 path-containment: --out outside platformDir exits 2", async () => {
    const code = await runQuery({
      text: "renewal charge",
      platformDir: clone,
      out: "/etc/passwd",
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/--out path must be inside platformDir/);
  });

  test("text mode renders header columns and contains the matching req_id", async () => {
    const code = await runQuery({
      text: "renewal charge",
      platformDir: clone,
      json: false,
    });
    expect(code).toBe(0);
    const out = logs[0] ?? "";
    expect(out).toContain("REQ_ID");
    expect(out).toContain("RANK");
    expect(out).toContain("SOURCE");
    expect(out).toContain("EXCERPT");
    expect(out).toContain("BILLING-009");
  });

  test("hit shape carries req_id + rank + source_file:line + text/excerpt", async () => {
    await runQuery({
      text: "renewal charge",
      platformDir: clone,
      json: true,
    });
    const parsed = JSON.parse(logs[0] ?? "[]") as Array<Record<string, unknown>>;
    expect(parsed.length).toBeGreaterThan(0);
    const hit = parsed[0];
    expect(typeof hit?.req_id).toBe("string");
    expect(typeof hit?.rank).toBe("number");
    expect(typeof hit?.source_file).toBe("string");
    expect(typeof hit?.line).toBe("number");
    expect(typeof hit?.text).toBe("string");
  });

  test("operational (non-FTS5) storage errors propagate unwrapped (WR-01 throw-e branch)", async () => {
    // Locks the `throw e` branch in commands/query.ts that became live
    // after WR-01 narrowed the storage-level wrap to actual FTS5 grammar
    // errors. Operational errors (database is locked, disk I/O,
    // corruption, missing FTS table, etc.) MUST propagate as raw
    // native bun:sqlite errors — NOT be relabeled as "spec query: FTS5
    // query syntax error", which would mislead users debugging a real
    // I/O or schema problem (IN-05 / WR-01 pairing in 04-REVIEW.md).
    //
    // Strategy: index once via a benign run, then DROP the FTS5 virtual
    // table out from under the storage layer. The next searchFts call
    // hits "no such table: requirements_fts" — a SQLITE_ERROR that does
    // NOT match the `/fts5:|syntax error/i` narrowing regex in
    // storage/sqlite.ts:429. Asserts the error escapes the command's
    // catch block via `throw e` (NOT the friendly stderr path) and that
    // no "FTS5 query syntax error" message is emitted to stderr.

    // 1. Warm the index with a normal query so .spec-engine/index.sqlite exists.
    const warm = await runQuery({
      text: "renewal charge",
      platformDir: clone,
      json: true,
    });
    expect(warm).toBe(0);

    // 2. Drop the FTS5 virtual table so the next searchFts fails with a
    //    non-grammar SQLITE_ERROR. Opening directly is fine in tests —
    //    D-08 grep-fence applies only to packages/engine/src/storage/sqlite.ts.
    const dbPath = join(clone, ".spec-engine", "index.sqlite");
    const direct = new Database(dbPath);
    direct.exec("DROP TABLE requirements_fts;");
    direct.close();

    // 3. Reset captured stderr so we can assert no FTS5-syntax message
    //    is emitted on the failing run.
    errs.length = 0;
    logs.length = 0;

    // 4. The second query MUST throw past runQuery (operational error,
    //    not an ExitError). If the `throw e` branch regressed back to
    //    wrapping everything as "FTS5 query syntax error", runQuery
    //    would instead return exit code 2.
    //
    // WR-06 (iter-3): use a `returnedNormally` boolean sentinel set ONLY
    //    inside the try block after the call succeeds, so a silent-swallow
    //    regression (e.g., refactor `throw e` to `return;`) is caught by
    //    a dedicated `expect(returnedNormally).toBe(false)` assertion
    //    rather than masquerading as a synthetic-Error success path.
    //    Without this, the prior single-variable shape let a synthetic
    //    `throw new Error("...")` inside the try flow into the same
    //    `propagated` slot as a real propagated SQLITE_ERROR, and every
    //    "not-FTS5-wrapped" assertion passed for the wrong reason.
    let returnedNormally = false;
    let propagated: unknown;
    try {
      await runQuery({
        text: "renewal charge",
        platformDir: clone,
        json: true,
      });
      // Only reached on silent-swallow regression — caught by step 5
      // below, NOT by the catch handler.
      returnedNormally = true;
    } catch (e) {
      propagated = e;
    }

    // 5. Catch the silent-swallow regression directly. If `runQuery`
    //    returned without throwing, the throw-e branch is broken.
    expect(returnedNormally).toBe(false);

    // 6. The propagated error must be a real Error (NOT an ExitError —
    //    that would mean the friendly process.exit(2) path ran), and
    //    its message must NOT be the wrapped "searchFts: FTS5 query
    //    syntax error..." form.
    expect(propagated).toBeInstanceOf(Error);
    const msg = (propagated as Error).message;
    expect(msg).not.toMatch(/^searchFts: FTS5 query syntax error/);

    // 7. Belt-and-braces: positively pin the propagated error to the
    //    operational-error shape we induced. Dropping the FTS5 virtual
    //    table makes the next searchFts hit a SQLITE_ERROR whose
    //    message contains "no such table: requirements_fts". Locking
    //    this shape catches a separate silent-failure mode: a storage
    //    seam rewrite that converts SQLITE_ERROR into some other
    //    message that happens to fail /^searchFts: FTS5/ but is still
    //    the wrong shape (e.g., a generic "internal error"). Pairs
    //    with the storage-side WR-01 narrowing.
    expect(msg).toMatch(/requirements_fts|no such table|SQLITE_ERROR/);

    // 8. Stderr must NOT contain the friendly user-facing FTS5 message —
    //    that would mean the command misclassified an operational error.
    expect(errs.join("\n")).not.toMatch(/FTS5 query syntax error/);
  });
});

// ---------- RED-11: pre-index / pre-spec guidance ----------
//
// A non-platform dir must produce the friendly first-spec message + exit 2
// (NOT the raw NotASpecPlatformError stack trace runIndex used to throw),
// and must write NO .spec-engine/ artifact — the old behavior littered an empty
// index that poisoned every later run into silently printing nothing.

describe("spec query — pre-index guidance (RED-11)", () => {
  function makeBareDir(): string {
    return mkdtempSync(join(tmpdir(), "spec-query-red11-"));
  }

  /** spec-engine/ present with a manifest but zero requirements. */
  function makeEmptyPlatform(): string {
    const dir = makeBareDir();
    mkdirSync(join(dir, "spec-engine"), { recursive: true });
    return dir;
  }

  test("non-platform dir: friendly message + exit 2, no stack trace, no .spec-engine artifact", async () => {
    const bare = makeBareDir();
    try {
      const code = await runQuery({ text: "renewal", platformDir: bare });
      expect(code).toBe(2);
      expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(true);
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

  test("empty platform (zero requirements): first-spec hint on stderr, exit 0, no stdout", async () => {
    const empty = makeEmptyPlatform();
    try {
      const code = await runQuery({ text: "renewal", platformDir: empty });
      expect(code).toBe(0);
      expect(errs.some((m) => m.includes("No requirements indexed"))).toBe(true);
      expect(errs.some((m) => m.includes("spec domain new"))).toBe(true);
      expect(logs.length).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("empty platform --json: stdout stays '[]', no hint on stderr", async () => {
    const empty = makeEmptyPlatform();
    try {
      const code = await runQuery({ text: "renewal", platformDir: empty, json: true });
      expect(code).toBe(0);
      expect(logs.find((l) => l.startsWith("["))).toBe("[]");
      expect(errs.some((m) => m.includes("No requirements indexed"))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
