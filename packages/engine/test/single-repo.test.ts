// packages/engine/test/single-repo.test.ts
//
// RUNG1-01: single-repo / "rung 1" mode end-to-end. A lone repo that keeps
// its specs inline under spec-engine/ and tags its own code (in normal
// src/ + test/ subdirs — the realistic layout) is indexed with ITSELF
// registered as the lone member (the self-member).
//
// RUNG1-02: the fixture deliberately puts code in src/ and test/ SUBDIRS (not
// loose at the platform root). Those plain config-less folders must NOT be
// enumerated as skipped siblings (they carry no .git/package.json repo-root
// marker), so the self-member still fires and its tags are scanned.
//
// These cases run against the COMMITTED fixtures/single-repo-fixture/ (NOT a
// tmpdir clone) so map/coverage assertions are reproducible and the README
// walkthrough exercises a real on-disk example. The DB itself is written to a
// per-test tmpdir file (not :memory:) so the file-mode open/close/reopen path
// is exercised (CLAUDE.md mandate; mirrors cold-rebuild.test.ts).
//
// Case (d) is the HARD multi-repo regression guard: indexing the existing
// fixtures/platform-fixture/ must still produce repos:4 / 5 requirements and
// must NOT leak a self-member row — self-member logic is inert whenever
// ≥1 sibling member exists.
//
// Storage-free at the test layer except via openStorage inside the command
// path (D-08): no direct bun:sqlite import here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NotASpecPlatformError } from "@spec-engine/shared";
import { collectDiagnostics } from "../src/check/sqlDiagnostics";
import { discoverRepos } from "../src/indexer/discover";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
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

describe("single-repo mode end-to-end (RUNG1-01)", () => {
  test("(a) index registers the self-member; ORDERS-001 implements+verifies tags present", async () => {
    const s = openStorage(dbPath);
    try {
      const result = await runIndex({ platformDir: SINGLE_REPO_FIXTURE, storage: s });
      // self-member + canonical spec-engine = 2 repos.
      expect(result.repos).toBe(2);

      const repoNames = s
        .listRepos()
        .map((r) => r.name)
        .sort();
      expect(repoNames).toEqual(["single-repo-fixture", "spec-engine"]);

      const self = s.getRepo("single-repo-fixture");
      expect(self).not.toBeNull();
      // pin === derived platformVersion (1: the fixture's ORDERS domain has no
      // supersede edges) → DRIFT structurally impossible (RED-85 / INIT-014).
      expect(self?.pinned_spec_version).toBe(1);

      // 3 tags scanned from the self-member's src/ + test/ code: ORDERS-001
      // (implements via src/orders.ts) + ORDERS-001 (verifies via
      // test/orders.test.ts) + ORDERS-002 (implements via src/orders.ts).
      // listTags is a Phase 1 stub,
      // so we assert the indexed tag COUNT via the IndexResult and confirm
      // attribution through the coverage VIEW below.
      expect(result.tags).toBe(3);

      // ORDERS-001 is both implemented AND verified, attributed to the
      // self-member column (never to "spec-engine").
      const cov001 = s
        .coverageMatrix()
        .find((r) => r.req_id === "ORDERS-001" && r.repo === "single-repo-fixture");
      expect(cov001?.implemented).toBe(1);
      expect(cov001?.verified).toBe(1);
    } finally {
      s.close();
    }
  });

  test("(b) coverage shows the basename column with ORDERS-001 implemented+verified", async () => {
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

  test("(c) check fires ORPHAN_REQ + UNVERIFIED_REQ, suppresses DRIFT + NO_SPEC_CONFIG", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: SINGLE_REPO_FIXTURE, storage: s });
      const codes = collectDiagnostics(s).map((d) => d.code);

      // ORDERS-003 has no tag → ORPHAN_REQ; ORDERS-002 is implemented but not
      // verified → UNVERIFIED_REQ (both planted, NOT silenced).
      expect(codes).toContain("ORPHAN_REQ");
      expect(codes).toContain("UNVERIFIED_REQ");

      // The self-member is pinned to the manifest version and is never a
      // skipped sibling, so neither DRIFT nor NO_SPEC_CONFIG can fire.
      expect(codes).not.toContain("DRIFT");
      expect(codes).not.toContain("NO_SPEC_CONFIG");
    } finally {
      s.close();
    }
  });

  test("(d) HARD REGRESSION: platform-fixture stays repos:4 / 5 reqs, no self-member leak", async () => {
    const s = openStorage(dbPath);
    try {
      const result = await runIndex({ platformDir: PLATFORM_FIXTURE, storage: s });
      expect(result.repos).toBe(4);
      expect(s.listRequirements().length).toBe(5);

      const repoNames = s
        .listRepos()
        .map((r) => r.name)
        .sort();
      // Exactly the four canonical names — NO basename self-member row.
      expect(repoNames).toEqual(["admin", "api", "mobile", "spec-engine"]);
    } finally {
      s.close();
    }
  });

  test("(e) NotASpecPlatform regression: bare dir (no spec-engine/) still throws", async () => {
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
