import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, sidecarPath, writeCache } from "./cache";

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

describe("tracker sidecar cache", () => {
  test("cold path: absent sidecar reads as {} and does not throw", async () => {
    const dir = freshPlatformDir();
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

    rmSync(sidecarPath(dir));
    expect(existsSync(dir)).toBe(true);

    const cache = await readCache(dir);
    expect(cache).toEqual({});
  });

  test("corrupt-tolerant: non-JSON garbage reads as {} without throwing", async () => {
    const dir = freshPlatformDir();
    await writeCache(dir, {});
    writeFileSync(sidecarPath(dir), "not json{");

    const cache = await readCache(dir);
    expect(cache).toEqual({});
  });

  test("no-throw write: an unwritable sidecar path degrades silently (returns false)", async () => {
    const dir = freshPlatformDir();
    // A read-only platform dir makes the mkdirSync of `.spec-engine/` fail with EACCES.
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
      expect(result).toBe(false);
      expect(existsSync(sidecarPath(dir))).toBe(false);
    } finally {
      // Restore perms so afterEach rmSync can clean up the fixture dir.
      chmodSync(dir, 0o700);
    }
  });
});
