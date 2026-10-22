// The fixture keeps its code in src/ and test/ subdirs on purpose: plain
// folders with no .git or package.json must not become skipped siblings, or
// the self-member would never fire. The committed fixture backs the README
// walkthrough, so it is indexed in place, never copied.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NotASpecPlatformError } from "@spec-engine/shared";
import { collectDiagnostics } from "../check/sqlDiagnostics";
import { openStorage } from "../storage/sqlite";
import { discoverRepos } from "./discover";
import { runIndex } from "./pipeline";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const SINGLE_REPO_FIXTURE = join(REPO_ROOT, "fixtures", "single-repo-fixture");
const PLATFORM_FIXTURE = join(REPO_ROOT, "fixtures", "platform-fixture");

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-single-repo-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("single-repo mode end-to-end", () => {
  test("index registers the self-member; ORDERS-001 implements+verifies tags present", async () => {
    const s = openStorage(dbPath);
    try {
      const result = await runIndex({ platformDir: SINGLE_REPO_FIXTURE, storage: s });
      expect(result.repos).toBe(2);

      const repoNames = s
        .listRepos()
        .map((r) => r.name)
        .sort();
      expect(repoNames).toEqual(["single-repo-fixture", "spec-engine"]);

      const self = s.getRepo("single-repo-fixture");
      expect(self).not.toBeNull();
      // The fixture's ORDERS domain has no supersede edges, so the derived
      // version is 1.
      expect(self?.pinned_spec_version).toBe(1);

      expect(result.tags).toBe(3);

      const cov001 = s
        .coverageMatrix()
        .find((r) => r.req_id === "ORDERS-001" && r.repo === "single-repo-fixture");
      expect(cov001?.implemented).toBe(1);
      expect(cov001?.verified).toBe(1);
    } finally {
      s.close();
    }
  });

  test("tag files are platform-relative, without the directory name", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: SINGLE_REPO_FIXTURE, storage: s });
      const files = [...new Set(s.listTags().map((t) => t.file))].sort();
      expect(files).toEqual(["src/orders.ts", "test/orders.test.ts"]);
    } finally {
      s.close();
    }
  });

  test("coverage shows the basename column with ORDERS-001 implemented+verified", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: SINGLE_REPO_FIXTURE, storage: s });

      const row = s
        .coverageMatrix()
        .find((r) => r.req_id === "ORDERS-001" && r.repo === "single-repo-fixture");
      expect(row).toBeDefined();
      expect(row?.implemented).toBe(1);
      expect(row?.verified).toBe(1);
    } finally {
      s.close();
    }
  });

  test("check fires ORPHAN_REQ + UNVERIFIED_REQ, suppresses DRIFT + NO_SPEC_CONFIG", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: SINGLE_REPO_FIXTURE, storage: s });
      const codes = collectDiagnostics(s).map((d) => d.code);

      // Planted: ORDERS-003 has no tag, ORDERS-002 has no test.
      expect(codes).toContain("ORPHAN_REQ");
      expect(codes).toContain("UNVERIFIED_REQ");

      expect(codes).not.toContain("DRIFT");
      expect(codes).not.toContain("NO_SPEC_CONFIG");
    } finally {
      s.close();
    }
  });

  test("platform-fixture stays repos:4 / 5 reqs, no self-member leak", async () => {
    const s = openStorage(dbPath);
    try {
      const result = await runIndex({ platformDir: PLATFORM_FIXTURE, storage: s });
      expect(result.repos).toBe(4);
      expect(s.listRequirements().length).toBe(5);

      const repoNames = s
        .listRepos()
        .map((r) => r.name)
        .sort();
      expect(repoNames).toEqual(["admin", "api", "mobile", "spec-engine"]);
    } finally {
      s.close();
    }
  });

  test("a bare dir with no spec-engine/ throws NotASpecPlatformError", async () => {
    const bare = join(tmp, "bare");
    await mkdir(bare, { recursive: true });
    let caught: unknown;
    try {
      await discoverRepos(bare);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotASpecPlatformError);
    expect((caught as NotASpecPlatformError).platformDir).toBe(resolve(bare));
  });
});
