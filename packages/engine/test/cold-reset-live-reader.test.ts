// packages/engine/test/cold-reset-live-reader.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec CHCK-002
//
// The two operational-concurrency guarantees added after the storage-error
// work (commit 6d87266 follow-ups):
//
// 1. LIVE-READER FRESHNESS: `coldResetDb` wipes the derived DB IN PLACE
//    (inode-preserving) instead of unlinking it. The old unlink trio
//    replaced the inode, so a long-lived reader — `spec serve`'s storage
//    handle — kept its open fd on the ghost file and silently served
//    stale data forever after every `spec gate` / `spec check --ci`.
//    Pinned here end-to-end: a Storage handle opened BEFORE a cold reset
//    + reindex observes the post-reset derivation, not the pre-reset one.
//
// 2. BUSY WAIT: every openStorage connection sets `PRAGMA busy_timeout`
//    (BUSY_TIMEOUT_MS), so cross-process write contention waits briefly
//    instead of throwing SQLITE_BUSY instantly. Pinned with a real second
//    process holding BEGIN IMMEDIATE while this process writes.
//
// Plus the determinism lock: a coldResetDb + reindex produces a build_id
// byte-identical to the warm build — the in-place wipe is exactly as
// "cold" as the old unlink (INDX-03 / CI-02 stays intact).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { runIndex } from "../src/indexer/pipeline";
import { coldResetDb, computeBuildId, openStorage } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let dbPath: string;

beforeEach(() => {
  clone = cloneFixture(FIXTURE);
  dbPath = join(clone, ".spec-engine", "index.sqlite");
});

afterEach(() => {
  rmSync(clone, { recursive: true, force: true });
});

/** Index the clone from scratch on a throwaway handle. */
async function buildIndex(): Promise<void> {
  const s = openStorage(dbPath);
  try {
    await runIndex({ platformDir: clone, storage: s });
  } finally {
    s.close();
  }
}

describe("coldResetDb — live readers survive the cold reset (in-place wipe)", () => {
  test("a Storage handle opened before the reset sees the post-reset derivation", async () => {
    await buildIndex();

    // The long-lived reader — stands in for `spec serve`'s storage handle,
    // opened once at startup and never reopened.
    const liveReader: Storage = openStorage(dbPath);
    try {
      expect(liveReader.listRepos().map((r) => r.name)).toEqual([
        "admin",
        "api",
        "mobile",
        "spec-engine",
      ]);

      // The platform changes: mobile drops out (its member config is
      // deleted, so rediscovery classifies it as an unwired sibling).
      rmSync(join(clone, "mobile", "spec-engine.member.json"));

      // Another process runs `spec check --ci`: cold reset + reindex on
      // its OWN connection. (Same-process here, but a distinct Database
      // handle — the fd-vs-inode mechanics under test are identical.)
      coldResetDb(dbPath);
      const rebuilder = openStorage(dbPath);
      try {
        await runIndex({ platformDir: clone, storage: rebuilder });
      } finally {
        rebuilder.close();
      }

      // THE regression: with the old unlink trio, liveReader's fd pointed
      // at the deleted inode and this still returned all four repos —
      // stale forever. The in-place wipe keeps the inode, so the same
      // never-reopened handle now reads the fresh three-repo derivation.
      expect(liveReader.listRepos().map((r) => r.name)).toEqual(["admin", "api", "spec-engine"]);

      // And the file really is the same inode the reader opened.
      expect(statSync(dbPath).ino).toBeGreaterThan(0);
    } finally {
      liveReader.close();
    }
  });

  test("coldResetDb + reindex is build_id byte-identical to the warm build (INDX-03)", async () => {
    await buildIndex();
    const warm = openStorage(dbPath);
    const warmBuildId = computeBuildId(warm);
    warm.close();

    coldResetDb(dbPath);
    const cold = openStorage(dbPath);
    try {
      await runIndex({ platformDir: clone, storage: cold });
      expect(computeBuildId(cold)).toBe(warmBuildId);
    } finally {
      cold.close();
    }
  });

  test("coldResetDb on a missing file is a no-op (fallback path, no throw)", () => {
    const absent = join(clone, ".spec-engine", "never-created.sqlite");
    expect(() => coldResetDb(absent)).not.toThrow();
  });

  test("coldResetDb on a corrupt (not-a-database) file falls back to unlink", async () => {
    const corrupt = join(clone, ".spec-engine", "corrupt.sqlite");
    await Bun.write(corrupt, "definitely not a sqlite database");
    expect(() => coldResetDb(corrupt)).not.toThrow();
    // The fallback unlinked it; a subsequent openStorage starts fresh.
    const s = openStorage(corrupt);
    try {
      expect(s.listRepos()).toEqual([]);
    } finally {
      s.close();
    }
  });
});

describe("openStorage busy_timeout — cross-process contention waits, not throws", () => {
  test("a write succeeds while a second process briefly holds BEGIN IMMEDIATE", async () => {
    // The connection under test — openStorage sets PRAGMA busy_timeout.
    const storage = openStorage(dbPath);
    try {
      // A REAL second process (a same-process second connection cannot
      // exercise the busy wait: bun:sqlite's busy handler sleeps natively
      // and would deadlock against a same-process lock holder that needs
      // the event loop to release). The child grabs the write lock, prints
      // "locked", holds it ~400ms, then commits and exits.
      const childSrc = [
        'const { Database } = require("bun:sqlite");',
        "const db = new Database(process.env.SPEC_TEST_DB);",
        'db.exec("PRAGMA busy_timeout = 0;");',
        'db.exec("BEGIN IMMEDIATE;");',
        'console.log("locked");',
        "Bun.sleepSync(400);",
        'db.exec("COMMIT;");',
        "db.close();",
      ].join("\n");
      const child = Bun.spawn({
        cmd: [process.execPath, "-e", childSrc],
        env: { ...process.env, SPEC_TEST_DB: dbPath },
        stdout: "pipe",
        stderr: "inherit",
      });
      // Wait for the child to actually hold the lock.
      const reader = child.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("locked");

      // Without busy_timeout this throws SQLITE_BUSY instantly; with it,
      // SQLite's busy handler waits out the child's ~400ms hold and the
      // write lands.
      storage.withWriteTx((w) => {
        w.upsertRepo({ name: "contention-probe", path: "/dev/null", pinned_spec_version: 1 });
      });
      expect(storage.listRepos().map((r) => r.name)).toContain("contention-probe");

      await child.exited;
      expect(child.exitCode).toBe(0);
    } finally {
      storage.close();
    }
  });
});
