// @spec INDX-007

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStorage } from "../storage/sqlite";
import { cloneFixture } from "../testing/cloneFixture";
import { entryOf, plantEdit } from "../testing/plant";
import { runIndex } from "./pipeline";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-cold-rebuild-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Leftover `-wal`/`-shm` files would make a "cold" rebuild warm. */
function removeDbAndWalSiblings(path: string): void {
  for (const sfx of ["", "-wal", "-shm"]) {
    const p = path + sfx;
    if (existsSync(p)) rmSync(p);
  }
}

describe("cold-rebuild equivalence", () => {
  test("warm re-index against the same DB file → identical build_id", async () => {
    const s = openStorage(dbPath);
    try {
      const a = await runIndex({ platformDir: FIXTURE, storage: s });
      const b = await runIndex({ platformDir: FIXTURE, storage: s });
      expect(a.build_id).toBe(b.build_id);
      expect(a.build_id).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      s.close();
    }
  });

  test("rm DB + WAL siblings + fresh re-index → identical build_id", async () => {
    const s1 = openStorage(dbPath);
    const a = await runIndex({ platformDir: FIXTURE, storage: s1 });
    s1.close();

    removeDbAndWalSiblings(dbPath);
    expect(existsSync(dbPath)).toBe(false);

    const s2 = openStorage(dbPath);
    const c = await runIndex({ platformDir: FIXTURE, storage: s2 });
    s2.close();

    expect(c.build_id).toBe(a.build_id);
  });

  test("editing a SPEC.json statement changes build_id; rebuilding unchanged content does not", async () => {
    const clone = cloneFixture(FIXTURE);
    // repos.path is hashed into build_id, so every build here reads the same clone.
    const build = async (db: string) => {
      const s = openStorage(join(tmp, db));
      try {
        return (await runIndex({ platformDir: clone, storage: s })).build_id;
      } finally {
        s.close();
      }
    };
    try {
      const before = await build("a.sqlite");
      expect(await build("b.sqlite")).toBe(before);

      await plantEdit(clone, "BILLING", (d) => {
        entryOf(d, "BILLING-001").statement += " Tax is computed at charge time.";
      });

      const after = await build("c.sqlite");
      expect(after).toMatch(/^[0-9a-f]{64}$/);
      expect(after).not.toBe(before);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  test("three-run stability: A == B (warm) and A == C (cold) and B == C", async () => {
    const s1 = openStorage(dbPath);
    const a = await runIndex({ platformDir: FIXTURE, storage: s1 });
    const b = await runIndex({ platformDir: FIXTURE, storage: s1 });
    s1.close();

    removeDbAndWalSiblings(dbPath);
    const s2 = openStorage(dbPath);
    const c = await runIndex({ platformDir: FIXTURE, storage: s2 });
    s2.close();

    expect(a.build_id).toBe(b.build_id);
    expect(a.build_id).toBe(c.build_id);
    expect(b.build_id).toBe(c.build_id);
  });
});
