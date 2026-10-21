// @spec RSLV-005

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { FILES_MAX } from "@spec-engine/shared";
import { cloneFixture } from "../testing/cloneFixture";
import { resolveCommand } from "./resolve";

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
const resolveRun = (resolveCommand as unknown as { run: RunFn }).run;

async function runResolve(args: Record<string, unknown>, rawArgs: string[] = []): Promise<number> {
  try {
    await resolveRun({ args, rawArgs });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

describe("spec resolve (in-process)", () => {
  test("no positional files exits 2 with usage message", async () => {
    const code = await runResolve({ files: undefined }, []);
    expect(code).toBe(2);
    expect(errs[0] ?? "").toMatch(/^spec resolve:/);
  });

  test("multi-positional files return BILLING-002 + BILLING-009 (--json)", async () => {
    const code = await runResolve(
      {
        files: "api/src/renew.ts",
        platformDir: clone,
        json: true,
      },
      ["api/src/renew.ts", "api/src/charge.ts"],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logs[0] ?? "[]") as Array<{ id: string }>;
    const ids = parsed.map((r) => r.id).sort();
    expect(ids).toEqual(["BILLING-002", "BILLING-009"]);
  });

  // @spec RSLV-004 unit
  test("byte-stability: two consecutive invocations produce identical JSON bytes", async () => {
    await runResolve({ files: "api/src/renew.ts", platformDir: clone, json: true }, [
      "api/src/renew.ts",
      "api/src/charge.ts",
    ]);
    const outA = logs[0] ?? "";
    logs.length = 0;
    await runResolve({ files: "api/src/renew.ts", platformDir: clone, json: true }, [
      "api/src/renew.ts",
      "api/src/charge.ts",
    ]);
    const outB = logs[0] ?? "";
    expect(outA).toBe(outB);
    expect(outA.length).toBeGreaterThan(2); // not just "[]"
  });

  test("comma-split fallback: 'a.ts,b.ts' single positional matches two positionals", async () => {
    const code = await runResolve(
      {
        files: "api/src/renew.ts,api/src/charge.ts",
        platformDir: clone,
        json: true,
      },
      [],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logs[0] ?? "[]") as Array<{ id: string }>;
    const ids = parsed.map((r) => r.id).sort();
    expect(ids).toEqual(["BILLING-002", "BILLING-009"]);
  });

  test("text mode renders REQ_ID/STATUS/TEXT header columns and contains both ids", async () => {
    const code = await runResolve({ files: "api/src/renew.ts", platformDir: clone }, [
      "api/src/renew.ts",
      "api/src/charge.ts",
    ]);
    expect(code).toBe(0);
    const out = logs[0] ?? "";
    expect(out).toContain("REQ_ID");
    expect(out).toContain("STATUS");
    expect(out).toContain("TEXT");
    expect(out).toContain("BILLING-002");
    expect(out).toContain("BILLING-009");
  });

  test("path containment: --out outside platformDir exits 2", async () => {
    const evilOut = resolve(clone, "..", "evil.sqlite");
    const code = await runResolve({ files: "api/src/renew.ts", platformDir: clone, out: evilOut }, [
      "api/src/renew.ts",
    ]);
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/--out path must be inside platformDir/);
  });

  test("absolute path normalizes to platform-relative and returns the same BILLING-009", async () => {
    const absPath = join(clone, "api/src/renew.ts");
    const code = await runResolve({ files: absPath, platformDir: clone, json: true }, [absPath]);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs[0] ?? "[]") as Array<{ id: string }>;
    const ids = parsed.map((r) => r.id);
    expect(ids).toContain("BILLING-009");
  });

  test("above-platformDir path exits 2", async () => {
    const code = await runResolve({ files: "../outside.ts", platformDir: clone, json: true }, [
      "../outside.ts",
    ]);
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/file path must be inside platformDir/);
  });

  // @spec RSLV-006 unit
  test("unknown file under platformDir returns empty JSON array (exit 0)", async () => {
    const code = await runResolve(
      { files: "api/src/no-such-file.ts", platformDir: clone, json: true },
      ["api/src/no-such-file.ts"],
    );
    expect(code).toBe(0);
    expect(logs[0]).toBe("[]");
  });

  test("snapshot lock: canonical files produce stable row projection", async () => {
    await runResolve(
      {
        files: "api/src/renew.ts",
        platformDir: clone,
        json: true,
      },
      ["api/src/renew.ts", "api/src/charge.ts"],
    );
    const parsed = JSON.parse(logs[0] ?? "[]") as Array<Record<string, unknown>>;

    // The storage-seam resolve tests cover the full Requirement projection.
    const shape = parsed.map((r) => ({
      id: r.id,
      key: r.key,
      seq: r.seq,
      status: r.status,
    }));
    expect(shape).toMatchSnapshot();
  });
});

describe("spec resolve — pre-index guidance", () => {
  function makeBareDir(): string {
    return mkdtempSync(join(tmpdir(), "spec-resolve-red11-"));
  }

  function makeEmptyPlatform(): string {
    const dir = makeBareDir();
    mkdirSync(join(dir, "spec-engine"), { recursive: true });
    return dir;
  }

  test("non-platform dir: friendly message + exit 2, no stack trace, no .spec-engine artifact", async () => {
    const bare = makeBareDir();
    try {
      const code = await runResolve({ files: "src/foo.ts", platformDir: bare }, []);
      expect(code).toBe(2);
      expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(true);
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

  test("non-platform dir is idempotent: 2nd run repeats the message (no stale-index poisoning)", async () => {
    const bare = makeBareDir();
    try {
      expect(await runResolve({ files: "src/foo.ts", platformDir: bare }, [])).toBe(2);
      errs.length = 0;
      logs.length = 0;
      expect(await runResolve({ files: "src/foo.ts", platformDir: bare }, [])).toBe(2);
      expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(true);
      expect(errs.some((m) => m.includes("No requirements indexed"))).toBe(false);
      expect(existsSync(join(bare, ".spec-engine"))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("empty platform (zero requirements): first-spec hint on stderr, exit 0, no stdout", async () => {
    const empty = makeEmptyPlatform();
    try {
      const code = await runResolve({ files: "src/foo.ts", platformDir: empty }, []);
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
      const code = await runResolve({ files: "src/foo.ts", platformDir: empty, json: true }, []);
      expect(code).toBe(0);
      expect(logs.find((l) => l.startsWith("["))).toBe("[]");
      expect(errs.some((m) => m.includes("No requirements indexed"))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("rawArgs flag stripping: --out=eq-form, -o short-form, --json never become positionals", async () => {
    // If any flag (or a consumed flag value) leaked into the positional
    // list, the file set would change and the trace below would differ.
    const code = await runResolve({ files: "api/src/renew.ts", platformDir: clone, json: true }, [
      "--json",
      "--out=.spec-engine/eq.sqlite",
      "--out",
      ".spec-engine/space.sqlite",
      "-o",
      ".spec-engine/short.sqlite",
      "api/src/renew.ts",
      clone,
    ]);
    expect(code).toBe(0);
    const rows = JSON.parse(logs.find((l) => l.startsWith("[")) as string) as Array<{
      id: string;
    }>;
    expect(rows.map((r) => r.id)).toContain("BILLING-009");
    // A leaked flag value is an unknown-file input, which never widens the
    // row set, so the leak shows only as the misclassification warning.
    expect(errs.join("\n")).not.toContain("contains no spec-engine/");
  });

  test("2+ positionals with a real platformDir last: split = files + platformDir", async () => {
    const code = await runResolve({ files: "api/src/renew.ts", platformDir: clone, json: true }, [
      "api/src/renew.ts",
      clone,
    ]);
    expect(code).toBe(0);
    const rows = JSON.parse(logs.find((l) => l.startsWith("[")) as string) as Array<{
      req_id: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(errs.join("\n")).not.toContain("contains no spec-engine/");
  });

  test("last positional is a dir WITHOUT spec-engine/ → stderr warning, treated as file", async () => {
    const code = await runResolve({ files: "api/src/renew.ts", platformDir: clone, json: true }, [
      "api/src/renew.ts",
      join(clone, "api"),
    ]);
    expect(code).toBe(0);
    expect(errs.join("\n")).toContain("contains no spec-engine/");
  });

  test("last positional dir holds a FILE named spec-engine → same warning", async () => {
    // The decoy lives inside the clone so the path, treated as a file, still
    // passes the containment guard and the warning (not an exit 2) shows.
    const decoy = join(clone, "decoy");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, "spec-engine"), "not a directory");
    const code = await runResolve({ files: "api/src/renew.ts", platformDir: clone, json: true }, [
      "api/src/renew.ts",
      decoy,
    ]);
    expect(code).toBe(0);
    expect(errs.join("\n")).toContain("contains no spec-engine/");
  });

  test("more than FILES_MAX files → exit 2 with the cap message", async () => {
    const tooMany = Array.from({ length: FILES_MAX + 1 }, (_, i) => `src/f${i}.ts`);
    const code = await runResolve({ files: tooMany[0], platformDir: clone }, [...tooMany, clone]);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain(`too many files (max ${FILES_MAX}`);
  });
});

// In rung-1 mode tags are stored as `<repo-basename>/<rel>` but the natural
// input from the platform root is `<rel>` (e.g. `src/orders.ts`); both forms
// must resolve. The fixture is cloned because the command writes
// `<platformDir>/.spec-engine/index.sqlite` into the platform tree.
describe("spec resolve in self-member (rung-1) mode", () => {
  const SINGLE_REPO_FIXTURE = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "fixtures",
    "single-repo-fixture",
  );

  let rung1Clone: string;

  beforeEach(() => {
    rung1Clone = cloneFixture(SINGLE_REPO_FIXTURE);
  });

  afterEach(() => {
    rmSync(rung1Clone, { recursive: true, force: true });
  });

  test("natural platform-relative path resolves ORDERS-001 + ORDERS-002 (--json)", async () => {
    const code = await runResolve(
      { files: "src/orders.ts", platformDir: rung1Clone, json: true },
      [],
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(logs[0] ?? "[]") as Array<{ id: string }>;
    expect(parsed.map((r) => r.id)).toEqual(["ORDERS-001", "ORDERS-002"]);
  });

  test("basename-prefixed form keeps working (--json)", async () => {
    // The self-member's repo name is the platform dir's basename — for a
    // cloned fixture that's the tmpdir leaf, computed here rather than
    // hardcoded.
    const prefixed = `${basename(rung1Clone)}/src/orders.ts`;
    const code = await runResolve({ files: prefixed, platformDir: rung1Clone, json: true }, []);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs[0] ?? "[]") as Array<{ id: string }>;
    expect(parsed.map((r) => r.id)).toEqual(["ORDERS-001", "ORDERS-002"]);
  });
});

describe("spec resolve --req — reverse query", () => {
  test("--req lists every tag site for the requirement, deterministically ordered (JSON)", async () => {
    await resolveRun({
      args: { platformDir: clone, req: "BILLING-007", json: true },
      rawArgs: [],
    });
    const rows = JSON.parse(logs.join("\n")) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.req_id).toBe("BILLING-007");
      expect(typeof r.repo).toBe("string");
      expect(typeof r.file).toBe("string");
      expect(typeof r.line).toBe("number");
      expect(["implements", "verifies", "documents"]).toContain(r.kind as string);
      expect("id" in r).toBe(false); // AUTOINCREMENT id is an index detail
    }
    // The fixture tags BILLING-007 in more than one member repo — the
    // cross-repo view IS the point of the reverse query.
    const repos = new Set(rows.map((r) => r.repo));
    expect(repos.size).toBeGreaterThan(1);
    // Deterministic (repo, file, line) ordering.
    const keys = rows.map((r) => `${r.repo}|${r.file}|${String(r.line).padStart(6, "0")}`);
    expect(keys).toEqual([...keys].sort());
  });

  test("--req combined with file positionals is a usage error (exit 2)", async () => {
    let caught: ExitError | null = null;
    try {
      await resolveRun({
        args: { platformDir: clone, req: "BILLING-007", files: "api/src/renew.ts" },
        rawArgs: [],
      });
    } catch (e) {
      if (e instanceof ExitError) caught = e;
      else throw e;
    }
    expect(caught?.code).toBe(2);
    expect(errs.join("\n")).toContain("--req");
  });

  test("--req with a malformed id exits 2", async () => {
    let caught: ExitError | null = null;
    try {
      await resolveRun({ args: { platformDir: clone, req: "not-an-id" }, rawArgs: [] });
    } catch (e) {
      if (e instanceof ExitError) caught = e;
      else throw e;
    }
    expect(caught?.code).toBe(2);
  });

  test("--req with an unknown id prints [] (JSON) + guidance on stderr, exit 0", async () => {
    // NOT BILLING-999 — the fixture deliberately plants that as a dangling
    // tag (DANGLING_TAG defect), so it HAS tag sites. ZZZ-001 has neither a
    // requirement row nor any tag.
    await resolveRun({
      args: { platformDir: clone, req: "ZZZ-001", json: true },
      rawArgs: [],
    });
    expect(logs.join("\n").trim()).toBe("[]");
    expect(errs.join("\n")).toContain("ZZZ-001");
  });

  test("--req value never leaks into the positionals on a real argv (rawArgs path)", async () => {
    // The compiled-binary shape: `spec resolve --req BILLING-007 --json <dir>`.
    // --req must consume its value slot in extractPositionals (VALUE_FLAGS) or
    // "BILLING-007" lands as a phantom file positional and the command exits 2.
    await resolveRun({
      args: { req: "BILLING-007", json: true },
      rawArgs: ["--req", "BILLING-007", "--json", clone],
    });
    const rows = JSON.parse(logs.join("\n")) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.req_id === "BILLING-007")).toBe(true);
  });

  test("--req on a planted dangling tag still lists its sites (tags exist, requirement does not)", async () => {
    await resolveRun({
      args: { platformDir: clone, req: "BILLING-999", json: true },
      rawArgs: [],
    });
    const rows = JSON.parse(logs.join("\n")) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.req_id === "BILLING-999")).toBe(true);
  });
});
