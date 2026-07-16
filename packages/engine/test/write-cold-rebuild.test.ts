// packages/engine/test/write-cold-rebuild.test.ts
//
// VAL-03 cold-build invariant (T-21-10 / GATE-04): the new write surface must
// perturb `build_id` ONLY via the canonical JSON it writes — never via warm or
// incremental DB state, and `--results` (absent here) is never hashed in. This
// suite proves it: after a `POST /api/requirements` (which internally re-derives
// via runIndex on the warm storage handle), the stored build_id equals a COLD
// rebuild — delete the derived DB + WAL/SHM siblings and re-index from the
// now-updated canonical JSON. Two byte-identical build_ids ⇒ the write path
// cannot smuggle warm state into the hash.
//
// Modelled on json-cold-rebuild.test.ts (removeDbAndWalSiblings + build_id
// byte-identity) and reusing server-write.test.ts's compose/clone setup.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { composeServeApp } from "../src/commands/serve";
import { runIndex } from "../src/indexer/pipeline";
import { computeBuildId, openStorage } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const CANONICAL_FIXTURE = join(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let platformDir: string;
let dbPath: string;

beforeEach(() => {
  platformDir = cloneFixture(CANONICAL_FIXTURE);
  dbPath = join(platformDir, ".spec-engine", "test-index.sqlite");
});

afterEach(() => {
  rmSync(platformDir, { recursive: true, force: true });
});

/** Remove a sqlite DB file along with its `-wal` and `-shm` siblings
 *  (Pitfall 8 — leftover WAL files contaminate cold-rebuild assertions). */
function removeDbAndWalSiblings(path: string): void {
  for (const sfx of ["", "-wal", "-shm"]) {
    const p = path + sfx;
    if (existsSync(p)) rmSync(p);
  }
}

describe("VAL-03 cold-build invariant — build_id after write+reindex == cold rebuild", () => {
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

    // The build_id the route committed (read straight off the warm projection).
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

    // Byte-identity ⇒ the write path perturbed build_id ONLY via the JSON.
    expect(coldResult.build_id).toBe(warmBuildId);
  });
});
