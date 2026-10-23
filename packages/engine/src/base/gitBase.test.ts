import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAndTag, git } from "../testing/git";
import { TestPlatform } from "../testing/platform";
import {
  gitDiffNameStatus,
  gitLsTree,
  gitRefResolves,
  gitShow,
  isSafeRef,
  newestReleaseTag,
} from "./gitBase";

describe("gitBase — gitShow / gitLsTree (ref-validated argv-array git readers)", () => {
  let fx: TestPlatform;
  let repo: string;
  const REL = "spec-engine/BILLING/SPEC.json";

  beforeEach(async () => {
    fx = TestPlatform.temp("spec-gitbase-");
    repo = fx.dir;
    git(repo, "init", "-q");
    const billing = await fx.domain("BILLING", { owner: "drea" });
    await billing.req({ statement: "Charge on renew." });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
  });

  afterEach(() => {
    fx.remove();
  });

  test("gitShow returns the committed bytes at <ref>:<path>", () => {
    const bytes = gitShow(repo, "HEAD", REL);
    expect(bytes).not.toBeNull();
    expect(bytes as string).toContain("BILLING-001");
    expect((bytes as string).length).toBeGreaterThan(0);
  });

  test("gitShow returns null for a path absent at the ref (newly-added file has no base)", () => {
    expect(gitShow(repo, "HEAD", "spec-engine/BILLING/DOES_NOT_EXIST.json")).toBeNull();
  });

  test("gitLsTree lists the committed spec-engine/BILLING/SPEC.json", () => {
    const files = gitLsTree(repo, "HEAD", "spec-engine");
    expect(files).toContain(REL);
  });

  test("gitLsTree returns [] for a directory absent at the ref", () => {
    // git ls-tree of a non-existent path exits 0 with empty output — still [].
    expect(gitLsTree(repo, "HEAD", "does-not-exist")).toEqual([]);
  });

  describe("unsafe ref rejected BEFORE any spawn", () => {
    for (const bad of ["HEAD; rm -rf /", "--upload-pack=x", "a b", "$(whoami)", "HEAD|cat"]) {
      test(`gitShow(${JSON.stringify(bad)}) → null`, () => {
        expect(gitShow(repo, bad, REL)).toBeNull();
      });
      test(`gitLsTree(${JSON.stringify(bad)}) → []`, () => {
        expect(gitLsTree(repo, bad, "spec-engine")).toEqual([]);
      });
    }
  });

  describe("gitRefResolves distinguishes a resolvable ref from an unreadable one", () => {
    test("a committed HEAD resolves", () => {
      expect(gitRefResolves(repo, "HEAD")).toBe(true);
    });
    test("a misspelled / unfetched ref does NOT resolve (fail-closed, not a silent empty base)", () => {
      expect(gitRefResolves(repo, "no-such-ref-xyz")).toBe(false);
      expect(gitRefResolves(repo, "origin/main")).toBe(false);
    });
    test("an unsafe ref shape is rejected before any spawn", () => {
      expect(gitRefResolves(repo, "HEAD; rm -rf /")).toBe(false);
    });
    test("a non-git directory does NOT resolve", () => {
      const notRepo = mkdtempSync(join(tmpdir(), "spec-nonrepo-"));
      try {
        expect(gitRefResolves(notRepo, "HEAD")).toBe(false);
      } finally {
        rmSync(notRepo, { recursive: true, force: true });
      }
    });
  });

  test("a safe ref shape such as HEAD is accepted", () => {
    expect(gitShow(repo, "HEAD", REL)).not.toBeNull();
  });
});

describe("isSafeRef — a ref that git could read as an option never reaches a spawn", () => {
  // @spec GUARD-027 unit
  test("accepts ordinary branch, tag, and remote refs", () => {
    for (const ok of ["HEAD", "v0.7.0", "origin/main", "feature/x-1"]) {
      expect(isSafeRef(ok)).toBe(true);
    }
  });

  // @spec GUARD-027 unit
  test("rejects a leading hyphen, =, whitespace, and ;", () => {
    for (const bad of ["-foo", "--upload-pack=x", "-", "a=b", "a b", "HEAD;x", ""]) {
      expect(isSafeRef(bad)).toBe(false);
    }
  });

  // @spec GUARD-027 unit
  test("every reader returns its empty value for a hyphen-led ref without spawning git", () => {
    const spawn = spyOn(Bun, "spawnSync");
    try {
      for (const bad of ["-foo", "--upload-pack=x", "-"]) {
        expect(gitRefResolves(".", bad)).toBe(false);
        expect(gitShow(".", bad, "x")).toBeNull();
        expect(gitLsTree(".", bad, "x")).toEqual([]);
        expect(gitDiffNameStatus(".", bad)).toEqual([]);
      }
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });
});

describe("gitBase — newestReleaseTag", () => {
  // @spec REQ-047 unit
  test("the newest v* tag by version sort, ignoring other tags; null outside git or with none", () => {
    const dir = mkdtempSync(join(tmpdir(), "spec-release-"));
    try {
      expect(newestReleaseTag(dir)).toBeNull();
      commitAndTag(dir, "v0.9.0");
      git(dir, "tag", "v0.10.0");
      git(dir, "tag", "nightly");
      expect(newestReleaseTag(dir)).toBe("v0.10.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // @spec REQ-047 unit
  test("a repository with commits but no v* tag has no release", () => {
    const dir = mkdtempSync(join(tmpdir(), "spec-release-"));
    try {
      commitAndTag(dir, "nightly");
      expect(newestReleaseTag(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gitBase — an inherited GIT_DIR does not redirect the platform's repository", () => {
  let platform: string;
  let decoy: string;
  const saved = process.env.GIT_DIR;

  beforeEach(() => {
    platform = mkdtempSync(join(tmpdir(), "spec-gitbase-platform-"));
    decoy = mkdtempSync(join(tmpdir(), "spec-gitbase-decoy-"));
    commitAndTag(platform, "v1.0.0");
    commitAndTag(decoy, "decoy");
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
    rmSync(platform, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  });

  // @spec GUARD-030 unit
  test("refs resolve against the platform dir's repository, not GIT_DIR", () => {
    process.env.GIT_DIR = join(decoy, ".git");
    expect(gitRefResolves(platform, "v1.0.0")).toBe(true);
    expect(gitRefResolves(platform, "decoy")).toBe(false);
    expect(newestReleaseTag(platform)).toBe("v1.0.0");
  });

  // @spec GUARD-030 unit
  test("a hook's relative GIT_DIR inside the platform repository still reads it", () => {
    process.env.GIT_DIR = ".git";
    expect(gitRefResolves(platform, "v1.0.0")).toBe(true);
  });
});
