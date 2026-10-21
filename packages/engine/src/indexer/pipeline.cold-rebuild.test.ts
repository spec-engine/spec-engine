// @spec INDX-007

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStorage } from "../storage/sqlite";
import { specTag } from "../testing/specTag";
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

  test("mutated fixture content produces a different build_id", async () => {
    const sA = openStorage(dbPath);
    const a = await runIndex({ platformDir: FIXTURE, storage: sA });
    sA.close();

    const modFixture = join(tmp, "modified-fixture");
    await mkdir(join(modFixture, "spec-engine", "BILLING"), { recursive: true });
    await mkdir(join(modFixture, "api", "src"), { recursive: true });
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

    const modDbPath = join(tmp, "modified.sqlite");
    const sB = openStorage(modDbPath);
    const b = await runIndex({ platformDir: modFixture, storage: sB });
    sB.close();

    expect(b.build_id).not.toBe(a.build_id);
    expect(b.build_id).toMatch(/^[0-9a-f]{64}$/);
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
