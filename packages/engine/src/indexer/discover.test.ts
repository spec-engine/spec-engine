// packages/engine/src/indexer/discover.test.ts
//
// @spec INIT-037
// @spec INIT-032
// @spec INIT-035
// @spec CHCK-031
// @spec INIT-034

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { NotASpecPlatformError } from "@spec-engine/shared";
import { TestPlatform } from "../testing/platform";
import {
  assertSpecPlatform,
  discoverRepos,
  locateMember,
  packageColumnName,
  platformMode,
  readRepoConfig,
} from "./discover";

/** A planted SPEC.json that is not JSON at all. */
const NOT_JSON = join(import.meta.dir, "..", "testing", "fixtures", "diagnostics", "not-json");
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

/** A domain whose derived version is `version`: one Active head behind `version - 1` supersede edges. */
async function writeVersionedDomain(root: string, key: string, version: number): Promise<void> {
  await (await TestPlatform.at(root).domain(key)).chain(version);
}

let tmp: string;
let fx: TestPlatform;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-discover-test-"));
  fx = TestPlatform.at(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("a declared platform: membership comes from the platform file", () => {
  test("declared members are the coverage columns; a declared member without a pin is unpinned", async () => {
    await fx.member("api", { pin: "spec-engine@2" });
    await fx.member("admin");
    fx.unpinned("mobile");

    const r = await discoverRepos(tmp);

    expect(r.mode).toBe("multi-repo");
    expect(r.members.map((m) => [m.name, m.pinned_spec_version])).toEqual([
      ["admin", 1],
      ["api", 2],
    ]);
    expect(r.members[1]?.path).toBe(join(tmp, "api"));
    expect(r.unpinned).toEqual([{ name: "mobile", path: join(tmp, "mobile") }]);
    expect(r.undeclared).toEqual([]);
    expect(r.diagnostics).toEqual([]);
    expect(r.members.some((m) => m.selfMember)).toBe(false);
  });

  test("a repository in the platform folder that nobody declared is undeclared, never a member and never NO_SPEC_CONFIG", async () => {
    await fx.member("api");
    fx.repository("strangers");

    const r = await discoverRepos(tmp);

    expect(r.members.map((m) => m.name)).toEqual(["api"]);
    expect(r.unpinned).toEqual([]);
    expect(r.undeclared).toEqual([{ name: "strangers", path: join(tmp, "strangers") }]);
    expect(r.diagnostics).toEqual([
      {
        code: "UNLISTED_REPO",
        severity: "warning",
        subject: "strangers",
        detail: expect.stringContaining("`spec init strangers`"),
      },
    ]);
  });

  test("a plain folder with no .git or package.json is neither a member nor a repository", async () => {
    await fx.member("api");
    mkdirSync(join(tmp, "src"));
    mkdirSync(join(tmp, "docs"));
    fx.file("docs/notes.md", "loose docs\n");

    const r = await discoverRepos(tmp);

    expect(r.members.map((m) => m.name)).toEqual(["api"]);
    expect(r.undeclared).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  test("a directory in the platform file's ignore list is never a candidate", async () => {
    await fx.member("api");
    fx.repository("scratch");
    const platformFile = JSON.parse(await Bun.file(join(tmp, "platform-map.json")).text());
    fx.file(
      "platform-map.json",
      `${JSON.stringify({ ...platformFile, ignore: ["scratch"] }, null, 2)}\n`,
    );

    const r = await discoverRepos(tmp);

    expect(r.undeclared).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  test("a declared member missing from disk is a MEMBER_MISSING warning and no column", async () => {
    await fx.member("api");
    await fx.member("gone");
    rmSync(join(tmp, "gone"), { recursive: true });

    const r = await discoverRepos(tmp);

    expect(r.members.map((m) => m.name)).toEqual(["api"]);
    expect(r.unpinned).toEqual([]);
    expect(r.diagnostics.map((d) => [d.code, d.severity, d.subject])).toEqual([
      ["MEMBER_MISSING", "warning", "gone"],
    ]);
  });

  test("a marker naming another platform is a MARKER_MISMATCH error; the member still scans", async () => {
    await fx.member("api");
    fx.file(
      "api/platform-map.json",
      `${JSON.stringify({ platform: "elsewhere", member: "api" })}\n`,
    );

    const r = await discoverRepos(tmp);

    expect(r.members.map((m) => m.name)).toEqual(["api"]);
    expect(r.diagnostics.map((d) => [d.code, d.severity])).toEqual([["MARKER_MISMATCH", "error"]]);
  });

  test("a monorepo member is one column per workspace package, prefixed by the member name, inheriting its pin unless a package pins itself", async () => {
    const shared = await fx.member("shared", { pin: "spec-engine@3" });
    shared.workspace(["packages/ui", "packages/core"]);
    await (await TestPlatform.at(shared.dir).domain("X")).chain(1);
    rmSync(join(shared.dir, "spec-engine"), { recursive: true });
    shared.file(
      "packages/core/spec-engine.member.json",
      `${JSON.stringify({ specs: "spec-engine@1" })}\n`,
    );

    const r = await discoverRepos(tmp);

    expect(r.members.map((m) => [m.name, m.pinned_spec_version])).toEqual([
      ["shared/packages/core", 1],
      ["shared/packages/ui", 3],
    ]);
    expect(r.members[1]?.path).toBe(join(shared.dir, "packages", "ui"));
    expect(r.members.some((m) => m.name === "shared")).toBe(false);
  });

  test("a member's ignore list rides on its column", async () => {
    await fx.member("api", { ignore: ["generated"] });
    await fx.member("web");

    const r = await discoverRepos(tmp);

    expect(r.members.find((m) => m.name === "api")?.ignore).toEqual(["generated"]);
    expect(r.members.find((m) => m.name === "web")?.ignore).toBeUndefined();
  });

  test("a malformed spec-engine.member.json still throws", async () => {
    await fx.member("member");
    await writeFile(join(tmp, "member", "spec-engine.member.json"), "{not valid json");

    await expect(discoverRepos(tmp)).rejects.toThrow(/failed to parse|failed validation/);
  });
});

describe("dependency depth comes from the platform map's dependsOn", () => {
  const depths = (members: Array<{ name: string; dependency_depth: number }>) =>
    members.map((m) => [m.name, m.dependency_depth]);

  // @spec PROP-006 unit
  test("a member sits one deeper than the deepest member it depends on; the rest are depth 0", async () => {
    await fx.member("shared");
    await fx.member("api", { dependsOn: ["shared"] });
    await fx.member("web", { dependsOn: ["api", "shared"] });
    await fx.member("zed");

    const r = await discoverRepos(tmp);

    expect(depths(r.members)).toEqual([
      ["api", 1],
      ["shared", 0],
      ["web", 2],
      ["zed", 0],
    ]);
  });

  // @spec PROP-006 unit
  test("a monorepo member's package columns carry their own package's dependsOn, across members too", async () => {
    await fx.member("core");
    const shared = await fx.member("shared");
    shared.workspace(["packages/ui", "packages/config"]);
    shared.file(
      "packages/ui/package.json",
      `${JSON.stringify({ name: "ui", private: true, dependencies: { config: "*", core: "*" } })}\n`,
    );
    await fx.member("web", { dependsOn: ["ui"] });

    const r = await discoverRepos(tmp);

    expect(depths(r.members)).toEqual([
      ["core", 0],
      ["shared/packages/config", 0],
      ["shared/packages/ui", 1],
      ["web", 2],
    ]);
  });

  // @spec PROP-006 unit
  test("a cycle and everything downstream of it sit at one depth after every other column", async () => {
    await fx.member("a", { dependsOn: ["b"] });
    await fx.member("b", { dependsOn: ["a"] });
    await fx.member("c", { dependsOn: ["a"] });
    await fx.member("lib");
    await fx.member("app", { dependsOn: ["lib"] });

    const r = await discoverRepos(tmp);

    expect(depths(r.members)).toEqual([
      ["a", 2],
      ["app", 1],
      ["b", 2],
      ["c", 2],
      ["lib", 0],
    ]);
  });

  // @spec PROP-006 unit
  test("a dependsOn name that is no column (a monorepo root, an absent package) is no edge", async () => {
    const mono = await fx.member("mono");
    mono.workspace(["packages/x"]);
    await fx.member("api", { dependsOn: ["mono", "nowhere"] });

    const r = await discoverRepos(tmp);

    expect(depths(r.members)).toEqual([
      ["api", 0],
      ["mono/packages/x", 0],
    ]);
  });

  // @spec PROP-006 unit
  test("a lone monorepo's packages are ordered by their dependsOn; a lone single repo is depth 0", async () => {
    fx.workspace(["packages/app", "packages/lib"]);
    fx.file(
      "packages/app/package.json",
      `${JSON.stringify({ name: "app", private: true, dependencies: { lib: "*" } })}\n`,
    );
    await writeVersionedDomain(tmp, "X", 1);

    const r = await discoverRepos(tmp);

    expect(depths(r.members)).toEqual([
      ["packages/app", 1],
      ["packages/lib", 0],
    ]);
    expect(r.canonical.dependency_depth).toBe(0);
  });
});

describe("a folder of repositories with no platform file is a preview: nothing is a member", () => {
  test("every repository is undeclared and the folder is an UNDECLARED_PLATFORM warning", async () => {
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    fx.repository("zulu");
    fx.repository("alpha");

    const r = await discoverRepos(tmp);

    expect(r.mode).toBe("multi-repo");
    expect(r.members).toEqual([]);
    expect(r.undeclared.map((d) => d.name)).toEqual(["alpha", "zulu"]);
    expect(r.diagnostics.map((d) => [d.code, d.severity, d.subject])).toEqual([
      ["UNDECLARED_PLATFORM", "warning", basename(tmp)],
    ]);
    expect(r.diagnostics[0]?.detail).toContain("`spec init <name>`");
    expect(r.diagnostics[0]?.detail).toContain("alpha, zulu");
  });
});

describe("a lone repository", () => {
  // @spec INIT-028 unit
  test("a lone single repo is its own column, named by its directory and pinned to the derived version", async () => {
    await writeVersionedDomain(tmp, "ALPHA", 3);
    await mkdir(join(tmp, "src"), { recursive: true });
    await mkdir(join(tmp, "test"), { recursive: true });

    const r = await discoverRepos(tmp);

    expect(r.mode).toBe("single-repo");
    expect(r.unpinned).toEqual([]);
    expect(r.undeclared).toEqual([]);
    expect(r.members).toEqual([
      {
        name: basename(resolve(tmp)),
        path: resolve(tmp),
        pinned_spec_version: 3,
        dependency_depth: 0,
        selfMember: true,
      },
    ]);
    expect(r.canonical.pinned_spec_version).toBe(3);
  });

  test("a lone single repo with one repository inside it is still a single repo (platform-map maps a folder of two or more)", async () => {
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    fx.repository("vendored");

    const r = await discoverRepos(tmp);

    expect(r.mode).toBe("single-repo");
    expect(r.members.map((m) => m.name)).toEqual([basename(tmp)]);
    expect(r.undeclared).toEqual([]);
  });

  test("a lone monorepo is one column per workspace package, named by the package path and pinned to the derived version", async () => {
    await writeVersionedDomain(tmp, "ALPHA", 2);
    fx.workspace(["packages/engine", "packages/shared", "scripts"]);

    const r = await discoverRepos(tmp);

    expect(r.mode).toBe("monorepo");
    expect(r.members.map((m) => [m.name, m.pinned_spec_version, m.selfMember])).toEqual([
      ["packages/engine", 2, undefined],
      ["packages/shared", 2, undefined],
      ["scripts", 2, undefined],
    ]);
    expect(r.members[0]?.path).toBe(join(tmp, "packages", "engine"));
    expect(r.members.some((m) => m.name === "packages")).toBe(false);
  });

  test("a nested spec-engine.member.json pins one package of a lone monorepo", async () => {
    await writeVersionedDomain(tmp, "ALPHA", 2);
    fx.workspace(["packages/engine", "packages/shared"]);
    fx.file(
      "packages/shared/spec-engine.member.json",
      `${JSON.stringify({ specs: "spec-engine@1", ignore: ["generated"] })}\n`,
    );

    const r = await discoverRepos(tmp);

    const shared = r.members.find((m) => m.name === "packages/shared");
    expect(shared?.pinned_spec_version).toBe(1);
    expect(shared?.ignore).toEqual(["generated"]);
    expect(r.members.find((m) => m.name === "packages/engine")?.pinned_spec_version).toBe(2);
  });

  test("a workspace glob that matches nothing leaves the repo a single column", async () => {
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    fx.manifest({ workspaces: ["packages/*"] });

    const r = await discoverRepos(tmp);

    expect(r.members.map((m) => m.name)).toEqual([basename(tmp)]);
    expect(r.members[0]?.selfMember).toBe(true);
    expect(r.diagnostics).toEqual([]);
  });

  test("a spec tree inside a larger repository is mapped as a lone single repo", async () => {
    const inside = join(REPO_ROOT, "fixtures", "single-repo-fixture");

    const r = await discoverRepos(inside);

    expect(r.mode).toBe("single-repo");
    expect(r.members.map((m) => m.name)).toEqual(["single-repo-fixture"]);
    expect(r.members[0]?.path).toBe(inside);
    expect(r.diagnostics).toEqual([]);
    expect(platformMode(inside)).toBe("single-repo");
  });
});

describe("platformMode", () => {
  test("reports platform-map's mode for a platform, a monorepo, and a single repo", async () => {
    await fx.member("api");
    expect(platformMode(tmp)).toBe("multi-repo");
    const mono = TestPlatform.temp();
    const single = TestPlatform.temp();
    try {
      mono.workspace(["packages/a"]);
      expect(platformMode(mono.dir)).toBe("monorepo");
      expect(platformMode(single.dir)).toBe("single-repo");
    } finally {
      mono.remove();
      single.remove();
    }
  });
});

describe("locateMember and packageColumnName", () => {
  test("a declared member locates its platform by the child-directory convention", async () => {
    const api = await fx.member("api");
    expect(locateMember(api.dir)).toEqual({ root: tmp, member: "api", conventional: true });
  });

  test("an undeclared repository under a platform folder locates the folder without a member name", async () => {
    await fx.member("api");
    const strangers = fx.repository("strangers");
    expect(locateMember(strangers.dir)).toEqual({ root: tmp, member: null, conventional: true });
  });

  test("a directory deeper inside a lone repository locates the repository root", async () => {
    mkdirSync(join(tmp, ".git"));
    fx.workspace(["packages/engine"]);
    const dir = join(tmp, "packages", "engine");
    expect(locateMember(dir)).toEqual({ root: tmp, member: null, conventional: false });
    expect(packageColumnName(tmp, dir)).toBe("packages/engine");
    expect(packageColumnName(tmp, join(tmp, "packages"))).toBeNull();
  });

  test("a package of a declared monorepo member is named <member>/<path>", async () => {
    const shared = await fx.member("shared");
    shared.workspace(["packages/ui"]);
    expect(packageColumnName(tmp, join(shared.dir, "packages", "ui"))).toBe("shared/packages/ui");
    expect(locateMember(join(shared.dir, "packages", "ui"))).toEqual({
      root: tmp,
      member: null,
      conventional: false,
    });
  });

  test("a directory with no platform anywhere above it locates nothing", async () => {
    const bare = mkdtempSync(join(tmpdir(), "spec-discover-bare-"));
    try {
      mkdirSync(join(bare, "anything"));
      expect(locateMember(join(bare, "anything"))).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("the nearest spec-engine/ wins over a repository boundary further up", async () => {
    mkdirSync(join(tmp, ".git"));
    const inner = TestPlatform.at(join(tmp, "inner"));
    const api = inner.repository("api");
    expect(locateMember(api.dir)).toEqual({ root: inner.dir, member: null, conventional: true });
  });
});

describe("the missing-canonical sentinel", () => {
  test("rejects with NotASpecPlatformError carrying the resolved platformDir when spec-engine/ is absent", async () => {
    const bare = join(tmp, "bare");
    mkdirSync(bare);
    let caught: unknown;
    try {
      await discoverRepos(bare);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotASpecPlatformError);
    expect((caught as NotASpecPlatformError).platformDir).toBe(resolve(bare));
  });

  test("assertSpecPlatform throws on absence only, never on emptiness", async () => {
    const bare = join(tmp, "bare");
    mkdirSync(bare);
    expect(() => assertSpecPlatform(bare)).toThrow(NotASpecPlatformError);
    expect(() => assertSpecPlatform(tmp)).not.toThrow();
  });
});

describe("readRepoConfig error contract", () => {
  test("unreadable path (a directory at the config path) → 'could not be read'", async () => {
    const configPath = join(tmp, "spec-engine.member.json");
    await mkdir(configPath, { recursive: true });
    await expect(readRepoConfig(configPath)).rejects.toThrow(/could not be read/);
  });

  test("syntactically valid JSON failing the pin schema → 'failed validation'", async () => {
    const configPath = join(tmp, "spec-engine.member.json");
    await writeFile(configPath, JSON.stringify({ specs: "not-a-pin" }));
    await expect(readRepoConfig(configPath)).rejects.toThrow(/failed validation/);
  });

  test("malformed JSON → 'failed to parse as JSON'", async () => {
    const configPath = join(tmp, "spec-engine.member.json");
    await writeFile(configPath, "{nope");
    await expect(readRepoConfig(configPath)).rejects.toThrow(/failed to parse as JSON/);
  });
});

describe("the derived platform version", () => {
  // @spec SCHM-022 unit
  // @spec SCHM-023 unit
  test("platformVersion = max domain version across the platform's SPEC.json files", async () => {
    await writeVersionedDomain(tmp, "ALPHA", 4);
    await writeVersionedDomain(tmp, "BETA", 2);

    const r = await discoverRepos(tmp);

    expect(r.platformVersion).toBe(4);
    expect(r.canonical.pinned_spec_version).toBe(4);
  });

  test("a stray retired spec-engine.platform.json is ignored, never parsed", async () => {
    await writeVersionedDomain(tmp, "ALPHA", 2);
    await writeFile(join(tmp, "spec-engine", "spec-engine.platform.json"), "{nope");

    const r = await discoverRepos(tmp);

    expect(r.platformVersion).toBe(2);
  });

  // @spec INIT-029 unit
  test("a domain SPEC.json the reader rejects contributes nothing", async () => {
    await writeVersionedDomain(tmp, "ALPHA", 3);
    cpSync(join(NOT_JSON, "spec-engine"), join(tmp, "spec-engine"), { recursive: true });

    const r = await discoverRepos(tmp);

    expect(r.platformVersion).toBe(3);
  });
});
