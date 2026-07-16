// packages/engine/test/cli-init.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INIT-001
// @spec INIT-002
// @spec INIT-003
// @spec INIT-004
// @spec INIT-013
//
// INIT-01..06, INIT-08..11, INIT-14: command-level tests for `spec init`.
//
// In-process invocation of the citty command with `process.exit` stubbed
// to throw `ExitError` so the test runner can assert on the numeric exit
// code without terminating mid-suite (Pitfall 9 — mirrors verbatim from
// cli-new.test.ts:30-34 and cli-check-unit.test.ts:27-31).
//
// Coverage map (9 describe blocks, ~18 tests):
//   INIT-01: default cwd + positional REPO + existence guard       (4 tests)
//   INIT-02: refuse inside spec-engine/ — 4 path-safety cases       (4 tests)
//   INIT-03: already configured no-force no-op (exit 0)            (1 test)
//   INIT-04: --force shape-safety (raw Object.keys — Pitfall 3)    (3 tests)
//   INIT-05: --specs Zod validation                                 (3 tests)
//   INIT-06/07: pin resolution (derived platform version) + note    (2 tests)
//   RED-85: stray retired manifest ignored + warned                 (1 test)
//   INIT-09/10: write seam + stdout summary                         (2 tests)
//   INIT-14: refuse on platform dir (contains spec-engine/)         (1 test)
//
// Storage-free: this file imports zero from `bun:sqlite` — D-08 grep-fence
// remains at exactly 1 src-side `bun:sqlite` import system-wide, in
// `packages/engine/src/storage/sqlite.ts:7`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initCommand } from "../src/commands/init";
import { writeVersionedDomain } from "./fixtures/versionedDomain";

let tmp: string;
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;
let originalCwd: string;

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "spec-cli-init-"));
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
  // process.exit is typed as `(code?: number) => never`; the stub throws so
  // callers can `try { ... } catch (ExitError) { ... }` instead of terminating
  // the test runner. Cast through unknown to a writable property.
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new ExitError(code ?? 0);
  };
});

afterEach(() => {
  // Restore cwd BEFORE rmSync so the rmSync target path is still valid even
  // if a test chdir'd into the tmp dir (INIT-01 default-cwd + INIT-02 (d)).
  try {
    process.chdir(originalCwd);
  } catch {
    // ignore — best-effort restore
  }
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  rmSync(tmp, { recursive: true, force: true });
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const initRun = (initCommand as unknown as { run: RunFn }).run;

// Numeric-return shape for INIT-11 exit-code matrix assertions
// (per PATTERNS.md lines 430-444). Returns 0 when run() returns cleanly
// (INIT-03 / INIT-11 success path), or the captured exit code otherwise.
async function runInit(args: Record<string, unknown>): Promise<number> {
  try {
    await initRun({ args, rawArgs: [] });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

describe("spec init — INIT-01 default cwd + positional repo + existence guard", () => {
  test("scaffolds in cwd when REPO is omitted", async () => {
    process.chdir(tmp);
    const code = await runInit({});
    expect(code).toBe(0);
    const written = await Bun.file(join(tmp, "spec-engine.member.json")).text();
    expect(written.includes("spec-engine@")).toBe(true);
  });

  test("scaffolds in REPO when positional is given", async () => {
    const code = await runInit({ repo: tmp });
    expect(code).toBe(0);
    const written = await Bun.file(join(tmp, "spec-engine.member.json")).text();
    expect(written.includes("spec-engine@")).toBe(true);
  });

  test("exits 2 with clear error when REPO does not exist", async () => {
    const code = await runInit({ repo: join(tmp, "nonexistent") });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("spec init:") && m.includes("does not exist"))).toBe(true);
  });

  test("exits 2 with clear error when REPO is a file (not directory)", async () => {
    writeFileSync(join(tmp, "file.txt"), "");
    const code = await runInit({ repo: join(tmp, "file.txt") });
    expect(code).toBe(2);
    // WR-06: assert the specific INIT-01 message, not just the "spec init:"
    // prefix (every exit-2 path prints that prefix — a generic assertion
    // passed on any failure mode and would mask a regression).
    expect(
      errs.some(
        (m) => m.includes("spec init:") && m.includes("does not exist or is not a directory"),
      ),
    ).toBe(true);
  });
});

describe("spec init — INIT-02 refuse inside spec-engine/ (4 cases: basename, nested, symlink, cwd-inside)", () => {
  test("(a) refuses when REPO basename is 'spec-engine'", async () => {
    mkdirSync(join(tmp, "spec-engine"), { recursive: true });
    const code = await runInit({ repo: join(tmp, "spec-engine") });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("spec init:") && m.includes("spec-engine"))).toBe(true);
  });

  test("(b) refuses when REPO is a subdirectory of spec-engine/", async () => {
    mkdirSync(join(tmp, "spec-engine", "BILLING"), { recursive: true });
    const code = await runInit({ repo: join(tmp, "spec-engine", "BILLING") });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("spec init:") && m.includes("spec-engine"))).toBe(true);
  });

  test("(c) refuses when REPO is a symlink resolving inside spec-engine/", async () => {
    mkdirSync(join(tmp, "spec-engine", "BILLING"), { recursive: true });
    symlinkSync(join(tmp, "spec-engine", "BILLING"), join(tmp, "myrepo"), "dir");
    const code = await runInit({ repo: join(tmp, "myrepo") });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("spec init:") && m.includes("spec-engine"))).toBe(true);
  });

  test("(d) refuses when cwd default resolves inside spec-engine/", async () => {
    mkdirSync(join(tmp, "spec-engine", "sub"), { recursive: true });
    process.chdir(join(tmp, "spec-engine", "sub"));
    const code = await runInit({});
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("spec init:") && m.includes("spec-engine"))).toBe(true);
  });
});

describe("spec init — INIT-03 already configured (no-force no-op, exit 0)", () => {
  test("prints existing pin + exits 0 when spec-engine.member.json exists and --force is false", async () => {
    writeFileSync(
      join(tmp, "spec-engine.member.json"),
      `${JSON.stringify({ specs: "spec-engine@7" }, null, 2)}\n`,
    );
    const code = await runInit({ repo: tmp });
    expect(code).toBe(0);
    expect(logs.some((m) => m.includes("already configured"))).toBe(true);
    expect(logs.some((m) => m.includes("spec-engine@7"))).toBe(true);
  });
});

describe("spec init — INIT-04 --force shape-safety (raw Object.keys, NOT Zod — Pitfall 3)", () => {
  test("--force overwrites cleanly when existing has only specs key", async () => {
    writeFileSync(
      join(tmp, "spec-engine.member.json"),
      `${JSON.stringify({ specs: "spec-engine@1" }, null, 2)}\n`,
    );
    const code = await runInit({ repo: tmp, force: true, specs: "spec-engine@2" });
    expect(code).toBe(0);
    const written = await Bun.file(join(tmp, "spec-engine.member.json")).text();
    const parsed = JSON.parse(written) as { specs: string };
    expect(parsed.specs).toBe("spec-engine@2");
  });

  test("--force refuses (exit 2) when existing has extra fields", async () => {
    writeFileSync(
      join(tmp, "spec-engine.member.json"),
      `${JSON.stringify({ specs: "spec-engine@1", customField: "foo" }, null, 2)}\n`,
    );
    const code = await runInit({ repo: tmp, force: true });
    expect(code).toBe(2);
    expect(
      errs.some(
        (m) =>
          m.includes("extra fields") &&
          m.includes("customField") &&
          m.includes("refusing to overwrite. Edit manually"),
      ),
    ).toBe(true);
  });

  test("--force exits 2 on JSON parse failure of existing file", async () => {
    writeFileSync(join(tmp, "spec-engine.member.json"), "{not valid");
    const code = await runInit({ repo: tmp, force: true });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("spec init:"))).toBe(true);
  });
});

describe("spec init — INIT-05 --specs Zod validation", () => {
  test("valid --specs writes that pin", async () => {
    const code = await runInit({ repo: tmp, specs: "spec-engine@42" });
    expect(code).toBe(0);
    const written = await Bun.file(join(tmp, "spec-engine.member.json")).text();
    const parsed = JSON.parse(written) as { specs: string };
    expect(parsed.specs).toBe("spec-engine@42");
  });

  test("invalid --specs (regex miss) exits 2 with ZodError surfaced to stderr", async () => {
    const code = await runInit({ repo: tmp, specs: "spec@1" });
    expect(code).toBe(2);
    expect(
      errs.some(
        (m) =>
          m.includes("spec init: --specs validation failed") &&
          m.includes("must be of the form spec-engine@N"),
      ),
    ).toBe(true);
  });

  test("invalid --specs (empty) exits 2", async () => {
    const code = await runInit({ repo: tmp, specs: "" });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("spec init: --specs validation failed"))).toBe(true);
  });
});

describe("spec init — INIT-06 + INIT-07 pin resolution + fallback note", () => {
  test("without --specs and no sibling platform, falls back to spec-engine@1 with stdout note (WR-02)", async () => {
    const code = await runInit({ repo: tmp });
    expect(code).toBe(0);
    const written = await Bun.file(join(tmp, "spec-engine.member.json")).text();
    const parsed = JSON.parse(written) as { specs: string };
    expect(parsed.specs).toBe("spec-engine@1");
    // WR-02: fallback is a SUCCESS path — note goes to stdout, not stderr.
    expect(
      logs.some((m) => m.includes("spec init:") && m.includes("falling back to spec-engine@1")),
    ).toBe(true);
  });

  test("without --specs, derives the pin from the platform's max domain version (RED-85)", async () => {
    await writeVersionedDomain(tmp, "ALPHA", 5);
    mkdirSync(join(tmp, "member"), { recursive: true });
    const code = await runInit({ repo: join(tmp, "member") });
    expect(code).toBe(0);
    const written = await Bun.file(join(tmp, "member", "spec-engine.member.json")).text();
    const parsed = JSON.parse(written) as { specs: string };
    expect(parsed.specs).toBe("spec-engine@5");
    expect(logs.some((m) => m.includes("derived platform version") && m.includes("5"))).toBe(true);
  });
});

describe("spec init — stray retired spec-engine.platform.json (RED-85)", () => {
  test("stray manifest is ignored with a stderr warning; the pin stays derived (exit 0)", async () => {
    // The old INIT-08 loud-on-malformed contract died with the manifest:
    // the file is never parsed, so even a malformed one cannot exit 2 —
    // but silence would leave the operator believing an authored counter
    // still steers the pin, so a retirement warning names the derived
    // version and tells them to delete the file.
    await writeVersionedDomain(tmp, "ALPHA", 2);
    writeFileSync(join(tmp, "spec-engine", "spec-engine.platform.json"), "{not valid");
    mkdirSync(join(tmp, "member"), { recursive: true });
    const code = await runInit({ repo: join(tmp, "member") });
    expect(code).toBe(0);
    const written = await Bun.file(join(tmp, "member", "spec-engine.member.json")).text();
    const parsed = JSON.parse(written) as { specs: string };
    expect(parsed.specs).toBe("spec-engine@2");
    expect(errs.some((m) => m.includes("retired and ignored") && m.includes("2"))).toBe(true);
  });
});

describe("spec init — INIT-09 + INIT-10 write seam + stdout summary", () => {
  test("writes pretty-printed JSON with trailing newline (INIT-09 / Pitfall 6)", async () => {
    const code = await runInit({ repo: tmp });
    expect(code).toBe(0);
    const body = await Bun.file(join(tmp, "spec-engine.member.json")).text();
    expect(body).toBe(`{\n  "specs": "spec-engine@1"\n}\n`);
    expect(body.endsWith("\n")).toBe(true);
  });

  test("stdout includes absolute path + resolved pin on success (INIT-10)", async () => {
    const code = await runInit({ repo: tmp });
    expect(code).toBe(0);
    expect(logs.some((m) => m.includes("spec init:") && m.includes(resolve(tmp)))).toBe(true);
    expect(logs.some((m) => m.includes("spec-engine@1"))).toBe(true);
  });
});

describe("spec init — INIT-14 refuse on platform dir (contains spec-engine/)", () => {
  test("REPO containing spec-engine/ as a child is refused with exit 2", async () => {
    mkdirSync(join(tmp, "spec-engine"), { recursive: true });
    const code = await runInit({ repo: tmp });
    expect(code).toBe(2);
    expect(
      errs.some(
        (m) =>
          m.includes("spec init:") &&
          m.includes("is a platform dir") &&
          m.includes("contains spec-engine/"),
      ),
    ).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// RED-14 dead-end audit. Two groups:
//   1. A REACHABLE BUG: a symlink loop at REPO made the step-2 statSync
//      throw ELOOP *uncaught* — a raw stack trace instead of the INIT-11
//      exit-2 contract that the realpathSync wrap two lines below already
//      honors. The first test below reproduces it; the fix wraps the stat.
//   2. The existing-config inspection branches (unreadable / non-object /
//      invalid pin / extra-fields warning) existed without covering tests.
// ----------------------------------------------------------------------------

describe("spec init — path-resolution failures honor INIT-11 exit 2 (RED-14)", () => {
  test("symlink loop at REPO → exit 2 with friendly message, no stack-trace crash", async () => {
    // `loop -> loop`: statSync follows symlinks and throws ELOOP.
    symlinkSync(join(tmp, "loop"), join(tmp, "loop"));
    const code = await runInit({ repo: join(tmp, "loop") });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("spec init:") && m.includes("cannot resolve"))).toBe(true);
  });
});

describe("spec init — existing-config inspection branches (RED-14)", () => {
  test("unreadable existing config (a directory at the config path) → exit 2 'could not be read'", async () => {
    mkdirSync(join(tmp, "spec-engine.member.json"), { recursive: true });
    const code = await runInit({ repo: tmp });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("could not be read"))).toBe(true);
  });

  test("existing config parses but is not a JSON object (array) → exit 2", async () => {
    writeFileSync(join(tmp, "spec-engine.member.json"), JSON.stringify([1, 2, 3]));
    const code = await runInit({ repo: tmp });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("is not a JSON object"))).toBe(true);
  });

  test("no-force with Zod-invalid pin shape → exit 2 surfacing the index-time error", async () => {
    writeFileSync(join(tmp, "spec-engine.member.json"), JSON.stringify({ specs: "not-a-pin" }));
    const code = await runInit({ repo: tmp });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("spec init:") && m.includes("failed validation"))).toBe(
      true,
    );
  });

  test("no-force with valid pin + extra fields → exit 0 with the WR-05 stdout warning", async () => {
    writeFileSync(
      join(tmp, "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@3", customField: "keep-me" }),
    );
    const code = await runInit({ repo: tmp });
    expect(code).toBe(0);
    expect(logs.some((m) => m.includes("already configured"))).toBe(true);
    expect(logs.some((m) => m.includes("extra fields") && m.includes("customField"))).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Audit hygiene pass T4 — `--json` machine mode: scaffold outcome as one
// parseable object. Errors keep the text-on-stderr + exit-2 contract.
// ----------------------------------------------------------------------------

describe("spec init --json — machine mode", () => {
  test("fresh scaffold emits {action:'wrote', path, pin, source} and writes the config", async () => {
    const code = await runInit({ repo: tmp, json: true });
    expect(code).toBe(0);
    expect(logs).toHaveLength(1);
    const obj = JSON.parse(logs[0] ?? "");
    expect(obj.action).toBe("wrote");
    expect((obj.path as string).endsWith("spec-engine.member.json")).toBe(true);
    expect(obj.pin).toBe("spec-engine@1");
    expect(typeof obj.source).toBe("string");
    const written = await Bun.file(join(tmp, "spec-engine.member.json")).text();
    expect(JSON.parse(written)).toEqual({ specs: "spec-engine@1" });
  });

  test("already-configured emits {action:'already-configured', path, pin, extra_fields}", async () => {
    writeFileSync(
      join(tmp, "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@3", customField: 1 }),
    );
    const code = await runInit({ repo: tmp, json: true });
    expect(code).toBe(0);
    expect(logs).toHaveLength(1);
    const obj = JSON.parse(logs[0] ?? "");
    expect(obj.action).toBe("already-configured");
    expect((obj.path as string).endsWith("spec-engine.member.json")).toBe(true);
    expect(obj.pin).toBe("spec-engine@3");
    expect(obj.extra_fields).toEqual(["customField"]);
  });
});

// ----------------------------------------------------------------------------
// Audit hygiene pass T7 — `ignore` is a first-class config field: init must
// not treat it as an unknown extra (no warning, no --force refusal), and a
// --force rewrite carries it forward instead of clobbering it.
// ----------------------------------------------------------------------------

describe("spec init × ignore field (T7)", () => {
  test("no-force: a config with specs+ignore is 'already configured' with NO extra-fields warning", async () => {
    writeFileSync(
      join(tmp, "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@2", ignore: ["generated"] }),
    );
    const code = await runInit({ repo: tmp });
    expect(code).toBe(0);
    expect(logs.some((m) => m.includes("already configured"))).toBe(true);
    expect(logs.some((m) => m.includes("extra fields"))).toBe(false);
  });

  test("--force rewrites the pin but preserves the ignore field", async () => {
    writeFileSync(
      join(tmp, "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@2", ignore: ["generated"] }),
    );
    const code = await runInit({ repo: tmp, force: true, specs: "spec-engine@3" });
    expect(code).toBe(0);
    const written = JSON.parse(await Bun.file(join(tmp, "spec-engine.member.json")).text());
    expect(written).toEqual({ specs: "spec-engine@3", ignore: ["generated"] });
  });

  test("--force still refuses on genuinely unknown extra fields", async () => {
    writeFileSync(
      join(tmp, "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@2", customField: 1 }),
    );
    const code = await runInit({ repo: tmp, force: true });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("extra fields") && m.includes("customField"))).toBe(true);
  });
});
