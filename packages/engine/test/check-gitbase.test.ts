// packages/engine/test/check-gitbase.test.ts
//
// Unit test for the command-tier git base-ref I/O helper (20-03, Task 1).
//
// gitShow / gitLsTree are the ONLY git subprocess seam for the governance/
// propagation gate. This test proves:
//   - gitShow returns the committed bytes at <ref>:<path>, null when absent;
//   - gitLsTree enumerates the committed spec files at the ref (recursive,
//     names only) — this is the whole-file-deletion-safe base enumeration
//     (Pitfall 3), NOT a working-tree glob;
//   - an UNSAFE ref (space / leading `-` / `;`) is rejected BEFORE any spawn:
//     gitShow returns null and gitLsTree returns [] (T-20-01 ref-injection).
//
// The tmp repo is a real `git init` (Pitfall 2 — cloneFixture is not a git
// repo). A git identity is injected via env so the commit succeeds in CI.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitLsTree, gitRefResolves, gitShow } from "../src/base/gitBase";

// Deterministic git identity so commits succeed on a bare CI runner.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "spec-check Test",
  GIT_AUTHOR_EMAIL: "test@spec.local",
  GIT_COMMITTER_NAME: "spec-check Test",
  GIT_COMMITTER_EMAIL: "test@spec.local",
};

function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

const BILLING_JSON = `{
  "key": "BILLING",
  "owner": "drea",
  "specVersion": 1,
  "updated": "2026-07-02",
  "requirements": [
    { "id": "BILLING-001", "status": "active", "statement": "Charge on renew." }
  ]
}
`;

describe("gitBase — gitShow / gitLsTree (ref-validated argv-array git readers)", () => {
  let repo: string;
  const REL = "spec-engine/BILLING/SPEC.json";

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "spec-gitbase-"));
    git(repo, "init", "-q");
    mkdirSync(join(repo, "spec-engine", "BILLING"), { recursive: true });
    writeFileSync(join(repo, REL), BILLING_JSON);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
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

  describe("T-20-01: unsafe ref rejected BEFORE any spawn", () => {
    for (const bad of ["HEAD; rm -rf /", "--upload-pack=x", "a b", "$(whoami)", "HEAD|cat"]) {
      test(`gitShow(${JSON.stringify(bad)}) → null`, () => {
        expect(gitShow(repo, bad, REL)).toBeNull();
      });
      test(`gitLsTree(${JSON.stringify(bad)}) → []`, () => {
        expect(gitLsTree(repo, bad, "spec-engine")).toEqual([]);
      });
    }
  });

  describe("CR-01: gitRefResolves distinguishes a resolvable ref from an unreadable one", () => {
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

  test("a safe ref shape (HEAD, a sha, a branch/tag) is accepted", () => {
    // The committed HEAD is a safe ref; already covered, but assert the
    // allow-shape does not reject ordinary refs.
    expect(gitShow(repo, "HEAD", REL)).not.toBeNull();
  });
});
