// @spec QURY-005

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cloneFixture } from "../testing/cloneFixture";
import { queryCommand } from "./query";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

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
  // A clone, so the indexer's .spec-engine/ writes land outside the
  // canonical fixtures/platform-fixture/ tree.
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

  test("'renewal charge' returns BILLING-009 as top hit (--json)", async () => {
    // Porter stemming (renewal ↔ renews) is covered at the storage seam by
    // the FTS tests; this pins it through the citty surface.
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

  test("path containment: --out outside platformDir exits 2", async () => {
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

  test("operational (non-FTS5) storage errors propagate unwrapped (the throw-e branch)", async () => {
    // Relabeling an operational error (locked DB, disk I/O, missing FTS
    // table) as an FTS5 syntax error would mislead someone debugging a real
    // I/O or schema problem. Dropping requirements_fts yields a SQLITE_ERROR
    // that the storage seam's FTS5 narrowing regex does not match.
    const warm = await runQuery({
      text: "renewal charge",
      platformDir: clone,
      json: true,
    });
    expect(warm).toBe(0);

    // A direct bun:sqlite open is allowed here: the engine-internal fence
    // skips tests.
    const dbPath = join(clone, ".spec-engine", "index.sqlite");
    const direct = new Database(dbPath);
    direct.exec("DROP TABLE requirements_fts;");
    direct.close();

    errs.length = 0;
    logs.length = 0;

    // A separate sentinel, so a swallowed error (`throw e` turned into
    // `return;`) cannot pass as a propagated one.
    let returnedNormally = false;
    let propagated: unknown;
    try {
      await runQuery({
        text: "renewal charge",
        platformDir: clone,
        json: true,
      });
      returnedNormally = true;
    } catch (e) {
      propagated = e;
    }

    expect(returnedNormally).toBe(false);

    expect(propagated).toBeInstanceOf(Error);
    const msg = (propagated as Error).message;
    expect(msg).not.toMatch(/^searchFts: FTS5 query syntax error/);

    expect(msg).toMatch(/requirements_fts|no such table|SQLITE_ERROR/);
    expect(errs.join("\n")).not.toMatch(/FTS5 query syntax error/);
  });
});

describe("spec query — pre-index guidance", () => {
  function makeBareDir(): string {
    return mkdtempSync(join(tmpdir(), "spec-query-red11-"));
  }

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
