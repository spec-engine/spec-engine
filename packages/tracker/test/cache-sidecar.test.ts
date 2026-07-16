// packages/tracker/test/cache-sidecar.test.ts
//
// TRK-07: the resolved-metadata sidecar cache is "derived but NOT index" — a
// deletable flat JSON file at `<platformDir>/.spec-engine/tracker-cache.json`, read
// and written entirely OUTSIDE the derived `.sqlite` index. These tests prove:
//   1. cold path: reading an absent sidecar returns {} and never throws,
//   2. round-trip: writeCache then readCache returns the stored entry,
//   3. deletable: deleting the sidecar leaves a subsequent read as the empty
//      cold path with no error (the index/platform dir is otherwise untouched),
//   4. corrupt-tolerant: a garbage (non-JSON) sidecar reads as {} without throw.
//
// Per CLAUDE.md, each test owns its OWN tmp platform dir (file-mode fixtures via
// mkdtempSync in os.tmpdir(), not :memory:) so parallel test files never share
// or mutate one fixture.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, sidecarPath, writeCache } from "../src/cache";

const dirs: string[] = [];

function freshPlatformDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spec-tracker-cache-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("tracker sidecar cache — deletable, never-hashed JSON (TRK-07)", () => {
  test("cold path: absent sidecar reads as {} and does not throw", async () => {
    const dir = freshPlatformDir();
    // No `.spec-engine/tracker-cache.json` exists in a fresh platform dir.
    expect(existsSync(sidecarPath(dir))).toBe(false);
    const cache = await readCache(dir);
    expect(cache).toEqual({});
  });

  test("round-trip: writeCache then readCache returns the stored entry", async () => {
    const dir = freshPlatformDir();
    const entry = {
      title: "Renewal charge applied twice",
      status: "In Progress",
      url: "https://linear.app/acme/issue/ENG-1",
      fetched_at: "2026-06-13T00:00:00.000Z",
    };
    await writeCache(dir, { "ENG-1": entry });

    expect(existsSync(sidecarPath(dir))).toBe(true);
    const cache = await readCache(dir);
    expect(cache["ENG-1"]).toEqual(entry);
    // Sidecar lives under `.spec-engine/` and is named `tracker-cache.json`.
    expect(sidecarPath(dir).endsWith(join(".spec-engine", "tracker-cache.json"))).toBe(true);
  });

  test("deletable: deleting the sidecar leaves the next read as the empty cold path", async () => {
    const dir = freshPlatformDir();
    await writeCache(dir, {
      "BILLING-009": {
        title: "Pin to superseded id",
        status: "Done",
        url: "https://linear.app/acme/issue/BILLING-009",
        fetched_at: "2026-06-13T00:00:00.000Z",
      },
    });
    expect(existsSync(sidecarPath(dir))).toBe(true);

    // Delete ONLY the sidecar file — the platform dir itself stays intact.
    rmSync(sidecarPath(dir));
    expect(existsSync(dir)).toBe(true);

    // A subsequent read is the empty cold path, with no throw (deletable).
    const cache = await readCache(dir);
    expect(cache).toEqual({});
  });

  test("corrupt-tolerant: non-JSON garbage reads as {} without throwing", async () => {
    const dir = freshPlatformDir();
    // Materialize a valid sidecar, then overwrite it with garbage.
    await writeCache(dir, {});
    writeFileSync(sidecarPath(dir), "not json{");

    const cache = await readCache(dir);
    expect(cache).toEqual({});
  });

  test("no-throw write: an unwritable sidecar path degrades silently (returns false)", async () => {
    const dir = freshPlatformDir();
    // Make the platform dir read-only so creating `.spec-engine/` (mkdirSync) fails
    // with EACCES — writeCache must swallow it and return false, never throw.
    chmodSync(dir, 0o500);
    try {
      let result: boolean | undefined;
      await expect(
        (async () => {
          result = await writeCache(dir, {
            "ENG-1": {
              title: "Renewal charge applied twice",
              status: "In Progress",
              url: "https://linear.app/acme/issue/ENG-1",
              fetched_at: "2026-06-13T00:00:00.000Z",
            },
          });
        })(),
      ).resolves.toBeUndefined();
      // A failed best-effort write reports false (the cache is derived/deletable).
      expect(result).toBe(false);
      expect(existsSync(sidecarPath(dir))).toBe(false);
    } finally {
      // Restore perms so afterEach rmSync can clean up the fixture dir.
      chmodSync(dir, 0o700);
    }
  });
});
