// @spec CHCK-014

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { runIndex } from "../indexer/pipeline";
import { cloneFixture } from "../testing/cloneFixture";
import { coldResetDb, computeBuildId, openStorage } from "./sqlite";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let dbPath: string;

beforeEach(() => {
  clone = cloneFixture(FIXTURE);
  dbPath = join(clone, ".spec-engine", "index.sqlite");
});

afterEach(() => {
  rmSync(clone, { recursive: true, force: true });
});

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

    // Stands in for `spec serve`'s handle, opened once and never reopened.
    const liveReader: Storage = openStorage(dbPath);
    try {
      expect(liveReader.listRepos().map((r) => r.name)).toEqual([
        "admin",
        "api",
        "mobile",
        "spec-engine",
      ]);

      rmSync(join(clone, "mobile", "spec-engine.member.json"));

      // Same process, but a distinct Database handle: the fd-versus-inode
      // mechanics are identical to a second process.
      coldResetDb(dbPath);
      const rebuilder = openStorage(dbPath);
      try {
        await runIndex({ platformDir: clone, storage: rebuilder });
      } finally {
        rebuilder.close();
      }

      // Unlinking instead of wiping in place would leave liveReader's fd on
      // the deleted inode, still returning all four repos.
      expect(liveReader.listRepos().map((r) => r.name)).toEqual(["admin", "api", "spec-engine"]);

      expect(statSync(dbPath).ino).toBeGreaterThan(0);
    } finally {
      liveReader.close();
    }
  });

  test("coldResetDb + reindex is build_id byte-identical to the warm build", async () => {
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
    const storage = openStorage(dbPath);
    try {
      // A real second process: bun:sqlite's busy handler sleeps natively and
      // would deadlock against a same-process lock holder that needs the
      // event loop to release.
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
      const reader = child.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("locked");

      storage.withWriteTx((w) => {
        w.upsertRepo({
          name: "contention-probe",
          path: "/dev/null",
          pinned_spec_version: 1,
          dependency_depth: 0,
        });
      });
      expect(storage.listRepos().map((r) => r.name)).toContain("contention-probe");

      await child.exited;
      expect(child.exitCode).toBe(0);
    } finally {
      storage.close();
    }
  });
});
