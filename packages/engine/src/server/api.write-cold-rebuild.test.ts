import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { composeServeApp } from "../commands/serve";
import { runIndex } from "../indexer/pipeline";
import { computeBuildId, openStorage } from "../storage/sqlite";
import { cloneFixture } from "../testing/cloneFixture";

const CANONICAL_FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "platform-fixture",
);

let platformDir: string;
let dbPath: string;

let priorFlags: string | undefined;

beforeEach(() => {
  // The write plane ships behind the editor feature flag.
  priorFlags = process.env.SPEC_FLAGS;
  process.env.SPEC_FLAGS = "editor";
  platformDir = cloneFixture(CANONICAL_FIXTURE);
  dbPath = join(platformDir, ".spec-engine", "test-index.sqlite");
});

afterEach(() => {
  if (priorFlags === undefined) delete process.env.SPEC_FLAGS;
  else process.env.SPEC_FLAGS = priorFlags;
  rmSync(platformDir, { recursive: true, force: true });
});

/** Leftover WAL files contaminate cold-rebuild assertions. */
function removeDbAndWalSiblings(path: string): void {
  for (const sfx of ["", "-wal", "-shm"]) {
    const p = path + sfx;
    if (existsSync(p)) rmSync(p);
  }
}

describe("cold-build invariant — build_id after write+reindex == cold rebuild", () => {
  test("a POST create leaves a build_id byte-identical to a cold rebuild from the updated JSON", async () => {
    // Warm path: the route writes BILLING/SPEC.json and re-derives on `storage`.
    const storage: Storage = openStorage(dbPath);
    const app = composeServeApp(storage, platformDir);
    const res = await app.request("/api/requirements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "BILLING",
        statement: "When a dispute is opened, freeze the associated payout.",
        why: "Chargeback correctness.",
      }),
    });
    expect(res.status).toBe(201);

    const warmBuildId = computeBuildId(storage);
    expect(warmBuildId).toMatch(/^[0-9a-f]{64}$/);
    storage.close();

    // Cold path: nuke the derived DB + WAL/SHM, then re-index the SAME (now
    // updated) canonical JSON into a fresh DB.
    removeDbAndWalSiblings(dbPath);
    expect(existsSync(dbPath)).toBe(false);
    const cold = openStorage(dbPath);
    const coldResult = await runIndex({ platformDir, storage: cold });
    cold.close();

    expect(coldResult.build_id).toBe(warmBuildId);
  });
});
