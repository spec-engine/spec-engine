// packages/engine/src/commands/init.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INIT-015
// @spec INIT-016
// @spec INIT-017
// @spec INIT-018
// @spec INIT-019
// @spec INIT-036
// @spec INIT-020
// @spec INIT-027
// @spec INIT-030
// @spec INIT-034
// @spec INIT-038
// @spec INIT-039

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverRepos } from "../indexer/discover";
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
    TestPlatform.at(tmp).repository("member");
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
    TestPlatform.at(tmp).repository("member");
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

describe("spec init × the retired members glob", () => {
  test("--force refuses a config still carrying a members glob as an unknown field", async () => {
    writeFileSync(
      join(tmp, "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@2", members: "*" }),
    );
    const code = await runInit({ repo: tmp, force: true });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("extra fields") && m.includes("members"))).toBe(true);
  });
});

describe("spec init declares a repository through platform-map", () => {
  test("an undeclared repository under the platform folder gets a platform file entry, a marker, and a pin", async () => {
    await writeVersionedDomain(tmp, "ALPHA", 2);
    const fx = TestPlatform.at(tmp);
    fx.repository("api");
    const code = await runInit({ repo: join(tmp, "api"), json: true });
    expect(code).toBe(0);
    const obj = JSON.parse(logs[0] ?? "");
    expect(obj.action).toBe("wrote");
    expect(obj.pin).toBe("spec-engine@2");
    const real = realpathSync(tmp);
    expect(obj.declared).toEqual([
      join(real, "platform-map.json"),
      join(real, "api", "platform-map.json"),
    ]);
    expect(obj.linked).toBeNull();
    expect(JSON.parse(await Bun.file(join(tmp, "platform-map.json")).text())).toEqual({
      name: fx.dir.split("/").at(-1),
      members: ["api"],
    });
    expect(JSON.parse(await Bun.file(join(tmp, "api", "platform-map.json")).text())).toEqual({
      platform: fx.dir.split("/").at(-1),
      member: "api",
    });
    const r = await discoverRepos(tmp);
    expect(r.members.map((m) => [m.name, m.pinned_spec_version])).toEqual([["api", 2]]);
  });

  test("a second repository joins the existing platform file; a declared member is not declared twice", async () => {
    const fx = TestPlatform.at(tmp);
    await fx.member("api");
    fx.repository("web");
    expect(await runInit({ repo: join(tmp, "web"), json: true })).toBe(0);
    const real = realpathSync(tmp);
    expect(JSON.parse(logs[0] ?? "").declared).toEqual([
      join(real, "platform-map.json"),
      join(real, "web", "platform-map.json"),
    ]);
    logs.length = 0;
    expect(await runInit({ repo: join(tmp, "api"), json: true })).toBe(0);
    const again = JSON.parse(logs[0] ?? "");
    expect(again.action).toBe("already-configured");
    expect(again.declared).toEqual([]);
    expect(JSON.parse(await Bun.file(join(tmp, "platform-map.json")).text()).members).toEqual([
      "api",
      "web",
    ]);
  });

  test("a declared member whose marker went missing gets it back", async () => {
    const fx = TestPlatform.at(tmp);
    const api = await fx.member("api");
    rmSync(join(api.dir, "platform-map.json"));
    expect(await runInit({ repo: api.dir, json: true })).toBe(0);
    expect(JSON.parse(logs[0] ?? "").declared).toEqual([
      join(realpathSync(api.dir), "platform-map.json"),
    ]);
  });

  test("a plain directory under the platform folder is refused: platform-map cannot declare it", async () => {
    mkdirSync(join(tmp, "spec-engine"), { recursive: true });
    mkdirSync(join(tmp, "plain"));
    const code = await runInit({ repo: join(tmp, "plain") });
    expect(code).toBe(2);
    expect(
      errs.some((m) => m.includes("spec init:") && m.includes("no .git entry or package.json")),
    ).toBe(true);
    expect(existsSync(join(tmp, "plain", "spec-engine.member.json"))).toBe(false);
    expect(existsSync(join(tmp, "platform-map.json"))).toBe(false);
  });

  test("a repository whose marker names another platform is refused before anything is written", async () => {
    const fx = TestPlatform.at(tmp);
    await fx.member("api");
    const other = fx.repository("other");
    other.file(
      "platform-map.json",
      `${JSON.stringify({ platform: "elsewhere", member: "other" })}\n`,
    );
    const code = await runInit({ repo: other.dir });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes('marker for platform "elsewhere"'))).toBe(true);
    expect(existsSync(join(other.dir, "spec-engine.member.json"))).toBe(false);
  });

  test("a workspace package of a lone monorepo gets a nested pin and no declaration", async () => {
    await writeVersionedDomain(tmp, "ALPHA", 3);
    const fx = TestPlatform.at(tmp);
    fx.workspace(["packages/engine", "scripts"]);
    const code = await runInit({ repo: join(tmp, "scripts"), json: true });
    expect(code).toBe(0);
    const obj = JSON.parse(logs[0] ?? "");
    expect(obj.pin).toBe("spec-engine@3");
    expect(obj.declared).toEqual([]);
    expect(existsSync(join(tmp, "platform-map.json"))).toBe(false);
    expect(existsSync(join(tmp, "scripts", "platform-map.json"))).toBe(false);
    const r = await discoverRepos(tmp);
    expect(r.members.map((m) => [m.name, m.pinned_spec_version])).toEqual([
      ["packages/engine", 3],
      ["scripts", 3],
    ]);
  });

  test("a repository inside a lone monorepo that is not a workspace package is refused", async () => {
    const fx = TestPlatform.at(tmp);
    fx.workspace(["packages/engine"]);
    fx.repository("tools");
    const code = await runInit({ repo: join(tmp, "tools") });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("is a monorepo") && m.includes("workspace packages"))).toBe(
      true,
    );
    expect(existsSync(join(tmp, "platform-map.json"))).toBe(false);
  });

  test("a directory deeper in a repository that is neither member nor package is refused", async () => {
    mkdirSync(join(tmp, ".git"));
    const fx = TestPlatform.at(tmp);
    fx.workspace(["packages/engine"]);
    mkdirSync(join(tmp, "packages", "engine", "src"), { recursive: true });
    const code = await runInit({ repo: join(tmp, "packages", "engine", "src") });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("neither a declared member nor a workspace package"))).toBe(
      true,
    );
  });

  test("a repository boundary between the target and an outer platform hides the platform: fallback pin", async () => {
    mkdirSync(join(tmp, "spec-engine"), { recursive: true });
    mkdirSync(join(tmp, "inner", ".git"), { recursive: true });
    mkdirSync(join(tmp, "inner", "member"), { recursive: true });
    const code = await runInit({ repo: join(tmp, "inner", "member") });
    expect(code).toBe(0);
    expect(
      JSON.parse(await Bun.file(join(tmp, "inner", "member", "spec-engine.member.json")).text()),
    ).toEqual({
      specs: "spec-engine@1",
    });
    expect(logs.some((m) => m.includes("falling back to spec-engine@1"))).toBe(true);
  });
});

describe("spec init --platform links a checkout that lives outside the platform folder", () => {
  let originalUserFile: string | undefined;

  beforeEach(() => {
    originalUserFile = process.env.PLATFORM_MAP_CONFIG;
    process.env.PLATFORM_MAP_CONFIG = join(tmp, "platforms.json");
  });

  afterEach(() => {
    if (originalUserFile === undefined) delete process.env.PLATFORM_MAP_CONFIG;
    else process.env.PLATFORM_MAP_CONFIG = originalUserFile;
  });

  test("records the checkout in the per-user file, derives the pin from the platform, and the platform then finds it there", async () => {
    const platform = TestPlatform.at(join(tmp, "platform"));
    await (await platform.domain("ALPHA")).chain(4);
    await platform.member("api", { files: { "src/a.ts": "export const a = 1;\n" } });
    mkdirSync(join(tmp, "elsewhere"));
    renameSync(join(platform.dir, "api"), join(tmp, "elsewhere", "api-checkout"));
    const checkout = join(tmp, "elsewhere", "api-checkout");
    rmSync(join(checkout, "spec-engine.member.json"));

    const code = await runInit({ repo: checkout, platform: platform.dir, json: true });

    expect(code).toBe(0);
    const obj = JSON.parse(logs[0] ?? "");
    expect(obj.action).toBe("wrote");
    expect(obj.pin).toBe("spec-engine@4");
    expect(obj.linked).toBe(join(tmp, "platforms.json"));
    expect(obj.declared).toEqual([]);
    expect(JSON.parse(await Bun.file(join(tmp, "platforms.json")).text())).toEqual({
      platform: { root: platform.dir, members: { api: realpathSync(checkout) } },
    });
    const r = await discoverRepos(platform.dir);
    expect(r.members.map((m) => [m.name, m.path])).toEqual([["api", realpathSync(checkout)]]);
    expect(r.diagnostics).toEqual([]);
  });

  test("a checkout without a marker cannot be linked", async () => {
    const platform = TestPlatform.at(join(tmp, "platform"));
    mkdirSync(join(tmp, "loose"));
    const code = await runInit({ repo: join(tmp, "loose"), platform: platform.dir });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("carries no platform-map.json marker"))).toBe(true);
    expect(existsSync(join(tmp, "platforms.json"))).toBe(false);
  });

  test("a missing member is a MEMBER_MISSING warning until it is linked", async () => {
    const platform = TestPlatform.at(join(tmp, "platform"));
    await platform.member("api");
    renameSync(join(platform.dir, "api"), join(tmp, "api-checkout"));
    const before = await discoverRepos(platform.dir);
    expect(before.diagnostics.map((d) => [d.code, d.subject])).toEqual([["MEMBER_MISSING", "api"]]);
    expect(before.diagnostics[0]?.detail).toContain("spec init --platform");
    expect(await runInit({ repo: join(tmp, "api-checkout"), platform: platform.dir })).toBe(0);
    const after = await discoverRepos(platform.dir);
    expect(after.diagnostics).toEqual([]);
    expect(after.members.map((m) => m.name)).toEqual(["api"]);
  });
});

describe("spec init — INIT-030 the engine scaffolds its own members", () => {
  const ENGINE = "@spec-engine/spec-engine";

  test("a checkout named spec-engine whose package is @spec-engine/spec-engine pins its own workspace package", async () => {
    const platform = TestPlatform.at(join(tmp, "spec-engine"));
    platform.workspace(["scripts"], { name: ENGINE });
    const code = await runInit({ repo: join(platform.dir, "scripts") });
    expect(code).toBe(0);
    const written = await Bun.file(join(platform.dir, "scripts", "spec-engine.member.json")).text();
    expect(written).toBe(`{\n  "specs": "spec-engine@1"\n}\n`);
  });

  test("the engine's own spec-engine/ tree is still refused", async () => {
    const platform = TestPlatform.at(join(tmp, "spec-engine"));
    platform.workspace(["scripts"], { name: ENGINE });
    const billing = await platform.domain("BILLING");
    const code = await runInit({ repo: join(billing.file, "..") });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("spec init:") && m.includes("spec-engine"))).toBe(true);
  });

  test("a platform under any other package name keeps the refusal", async () => {
    const platform = TestPlatform.at(join(tmp, "spec-engine"));
    platform.workspace(["scripts"], { name: "@acme/platform" });
    const code = await runInit({ repo: join(platform.dir, "scripts") });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("spec init:") && m.includes("spec-engine"))).toBe(true);
  });
});
