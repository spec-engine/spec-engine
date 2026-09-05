// packages/engine/src/commands/init.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INIT-015
// @spec INIT-016
// @spec INIT-017
// @spec INIT-018
// @spec INIT-019
// @spec INIT-031
// @spec INIT-020
// @spec INIT-027
// @spec INIT-030

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TestPlatform } from "../testing/platform";
import { initCommand } from "./init";

/** A domain whose derived version is `version`: one Active head behind `version - 1` supersede edges. */
async function writeVersionedDomain(root: string, key: string, version: number): Promise<void> {
  await (await TestPlatform.at(root).domain(key)).chain(version);
}

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
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new ExitError(code ?? 0);
  };
});

afterEach(() => {
  try {
    process.chdir(originalCwd);
  } catch {}
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  rmSync(tmp, { recursive: true, force: true });
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const initRun = (initCommand as unknown as { run: RunFn }).run;

/** 0 when run() returns cleanly, else the captured exit code. */
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

describe("spec init — INIT-04 --force shape-safety (raw Object.keys, not the schema)", () => {
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
  test("without --specs and no sibling platform, falls back to spec-engine@1 with stdout note", async () => {
    const code = await runInit({ repo: tmp });
    expect(code).toBe(0);
    const written = await Bun.file(join(tmp, "spec-engine.member.json")).text();
    const parsed = JSON.parse(written) as { specs: string };
    expect(parsed.specs).toBe("spec-engine@1");
    expect(
      logs.some((m) => m.includes("spec init:") && m.includes("falling back to spec-engine@1")),
    ).toBe(true);
  });

  test("without --specs, derives the pin from the platform's max domain version", async () => {
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

describe("spec init — stray retired spec-engine.platform.json", () => {
  test("stray manifest is ignored with a stderr warning; the pin stays derived (exit 0)", async () => {
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
  test("writes pretty-printed JSON with trailing newline (INIT-09)", async () => {
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

describe("spec init — path-resolution failures honor INIT-11 exit 2", () => {
  test("symlink loop at REPO → exit 2 with friendly message, no stack-trace crash", async () => {
    symlinkSync(join(tmp, "loop"), join(tmp, "loop"));
    const code = await runInit({ repo: join(tmp, "loop") });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("spec init:") && m.includes("cannot resolve"))).toBe(true);
  });
});

describe("spec init — existing-config inspection branches", () => {
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

  test("no-force with valid pin + extra fields → exit 0 with the stdout warning", async () => {
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

describe("spec init × ignore field", () => {
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

describe("spec init × members field", () => {
  test("no-force: a config with specs+members is 'already configured' with NO extra-fields warning", async () => {
    const mono = await TestPlatform.at(tmp).member("mono", { pin: "spec-engine@2", members: "*" });
    const code = await runInit({ repo: mono.dir });
    expect(code).toBe(0);
    expect(logs.some((m) => m.includes("already configured"))).toBe(true);
    expect(logs.some((m) => m.includes("extra fields"))).toBe(false);
  });

  test("--force rewrites the pin but preserves the members glob", async () => {
    const mono = await TestPlatform.at(tmp).member("mono", {
      pin: "spec-engine@2",
      ignore: ["generated"],
      members: "*",
    });
    const code = await runInit({ repo: mono.dir, force: true, specs: "spec-engine@3" });
    expect(code).toBe(0);
    const written = JSON.parse(await Bun.file(join(mono.dir, "spec-engine.member.json")).text());
    expect(written).toEqual({ specs: "spec-engine@3", ignore: ["generated"], members: "*" });
  });

  test("--force refuses (exit 2) a non-string members field, naming it", async () => {
    writeFileSync(
      join(tmp, "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@2", members: 1 }),
    );
    const code = await runInit({ repo: tmp, force: true });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("invalid members field"))).toBe(true);
  });
});

describe("spec init — INIT-030 the engine scaffolds its own members", () => {
  const enginePackage = JSON.stringify({ name: "@spec-engine/spec-engine" });

  test("a checkout named spec-engine whose package is @spec-engine/spec-engine scaffolds a member", async () => {
    const platform = TestPlatform.at(join(tmp, "spec-engine"));
    platform.file("package.json", enginePackage);
    mkdirSync(join(platform.dir, "scripts"));
    const code = await runInit({ repo: join(platform.dir, "scripts") });
    expect(code).toBe(0);
    const written = await Bun.file(join(platform.dir, "scripts", "spec-engine.member.json")).text();
    expect(written).toBe(`{\n  "specs": "spec-engine@1"\n}\n`);
  });

  test("the engine's own spec-engine/ tree is still refused", async () => {
    const platform = TestPlatform.at(join(tmp, "spec-engine"));
    platform.file("package.json", enginePackage);
    const billing = await platform.domain("BILLING");
    const code = await runInit({ repo: join(billing.file, "..") });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("spec init:") && m.includes("spec-engine"))).toBe(true);
  });

  test("a platform under any other package name keeps the refusal", async () => {
    const platform = TestPlatform.at(join(tmp, "spec-engine"));
    platform.file("package.json", JSON.stringify({ name: "@acme/platform" }));
    mkdirSync(join(platform.dir, "scripts"));
    const code = await runInit({ repo: join(platform.dir, "scripts") });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("spec init:") && m.includes("spec-engine"))).toBe(true);
  });
});
