// packages/engine/test/cold-rebuild.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INDX-001
//
// INDX-03 mechanical assertion: cold-rebuild equivalence.
// Verbatim pattern from 02-RESEARCH § CI test (CI-02) → phase-internal
// bun test (lines 1224-1257).
//
// Three assertions on the same fixture:
//   1. Same path warm re-index → identical build_id.
//   2. Delete DB + WAL/SHM siblings (Pitfall 8) → cold re-index → identical build_id.
//   3. Mutated fixture content (single requirement text changed) →
//      DIFFERENT build_id. (negative-case sanity so the hash isn't
//      trivially constant.)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";
import { specTag } from "./fixtures/specTag";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-cold-rebuild-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Remove a sqlite DB file along with its `-wal` and `-shm` siblings
 *  (Pitfall 8 — leftover WAL files contaminate cold-rebuild assertions). */
function removeDbAndWalSiblings(path: string): void {
  for (const sfx of ["", "-wal", "-shm"]) {
    const p = path + sfx;
    if (existsSync(p)) rmSync(p);
  }
}

describe("cold-rebuild equivalence (INDX-03 / CI-02)", () => {
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
    // Pass 1: warm index, capture build_id_A, then close.
    const s1 = openStorage(dbPath);
    const a = await runIndex({ platformDir: FIXTURE, storage: s1 });
    s1.close();

    // Cold: nuke the DB and its WAL/SHM siblings.
    removeDbAndWalSiblings(dbPath);
    expect(existsSync(dbPath)).toBe(false);

    // Pass 2: fresh open + index against the SAME fixture.
    const s2 = openStorage(dbPath);
    const c = await runIndex({ platformDir: FIXTURE, storage: s2 });
    s2.close();

    expect(c.build_id).toBe(a.build_id);
  });

  test("mutated fixture content produces a DIFFERENT build_id (negative-case sanity)", async () => {
    // Capture the canonical build_id.
    const sA = openStorage(dbPath);
    const a = await runIndex({ platformDir: FIXTURE, storage: sA });
    sA.close();

    // Build a tiny tmp fixture: copy the canonical BILLING/SPEC.md but
    // alter BILLING-007's requirement text by one character. Provide a
    // minimal member so discoverRepos returns at least one member.
    const modFixture = join(tmp, "modified-fixture");
    await mkdir(join(modFixture, "spec-engine", "BILLING"), { recursive: true });
    await mkdir(join(modFixture, "api", "src"), { recursive: true });
    // A minimal SPEC.md containing one Active requirement with a
    // deliberately different text byte set.
    const billingText = `---
key: BILLING
owner: drea
spec_version: 2
---

### BILLING-007 — Active
**Requirement:** When a charge is made, compute tax per region at charge time.X
**Why it matters:** Compliance.
`;
    await writeFile(join(modFixture, "spec-engine", "BILLING", "SPEC.md"), billingText);
    await writeFile(
      join(modFixture, "api", "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@2" }, null, 2),
    );
    await writeFile(
      join(modFixture, "api", "src", "tax.ts"),
      `${specTag("BILLING-007")}export const computeTax = () => 0;\n`,
    );

    // Index the modified fixture into a fresh DB.
    const modDbPath = join(tmp, "modified.sqlite");
    const sB = openStorage(modDbPath);
    const b = await runIndex({ platformDir: modFixture, storage: sB });
    sB.close();

    expect(b.build_id).not.toBe(a.build_id);
    expect(b.build_id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("three-run stability: A == B (warm) and A == C (cold) and B == C", async () => {
    // Pass 1 (warm)
    const s1 = openStorage(dbPath);
    const a = await runIndex({ platformDir: FIXTURE, storage: s1 });
    const b = await runIndex({ platformDir: FIXTURE, storage: s1 });
    s1.close();

    // Pass 2 (cold)
    removeDbAndWalSiblings(dbPath);
    const s2 = openStorage(dbPath);
    const c = await runIndex({ platformDir: FIXTURE, storage: s2 });
    s2.close();

    expect(a.build_id).toBe(b.build_id);
    expect(a.build_id).toBe(c.build_id);
    expect(b.build_id).toBe(c.build_id);
  });
});
