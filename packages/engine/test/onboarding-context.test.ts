// packages/engine/test/onboarding-context.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INIT-009
//
// INIT-07 / INIT-15: substrate tests for detectContext + findPlatformDirUpward.
// Locks all three kinds (platform / member / loose), the three-rule
// INIT-07 termination order (platform found → .git/ stop → fs root), and
// the DERIVED platform version (RED-85: max domain version via
// `derivePlatformVersion` — the authored spec-engine.platform.json manifest
// is retired; a stray one is ignored, never parsed).
//
// Storage-free: this file imports zero from `bun:sqlite` — D-08 grep-fence
// remains at exactly 1 src-side `bun:sqlite` import system-wide, in
// `packages/engine/src/storage/sqlite.ts:7`.
//
// References:
//   - RESEARCH § Pattern 2 (upward walk + termination guarantees)
//   - PATTERNS.md lines 285-355 (test-pattern map for this file)
//   - discover.test.ts:21-29 (mkdtempSync + per-test fixture lifecycle)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectContext, findPlatformDirUpward } from "../src/onboarding/context";
import { writeVersionedDomain } from "./fixtures/versionedDomain";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-onboarding-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("detectContext + findPlatformDirUpward (INIT-07 / INIT-15)", () => {
  test("kind='platform' derives version from the domains' supersede DAGs (max domain version)", async () => {
    await writeVersionedDomain(tmp, "ALPHA", 3);
    await writeVersionedDomain(tmp, "BETA", 2);

    const result = await detectContext(tmp);

    expect(result).toEqual({ kind: "platform", platformDir: tmp, platformVersion: 3 });
  });

  test("kind='platform' with no domains defaults to version 1", async () => {
    await mkdir(join(tmp, "spec-engine"), { recursive: true });

    const result = await detectContext(tmp);

    expect(result).toEqual({ kind: "platform", platformDir: tmp, platformVersion: 1 });
  });

  test("kind='member' with upward platform found populates platformDir + derived platformVersion", async () => {
    await writeVersionedDomain(tmp, "ALPHA", 2);
    await mkdir(join(tmp, "sub", "member"), { recursive: true });
    await writeFile(
      join(tmp, "sub", "member", "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@2" }),
    );

    const result = await detectContext(join(tmp, "sub", "member"));

    expect(result).toEqual({ kind: "member", platformDir: tmp, platformVersion: 2 });
  });

  test("kind='member' with .git boundary stop halts walk before reaching outer platform (INIT-07 / Pitfall 4)", async () => {
    // tmp/spec-engine/ exists at the OUTER level — the walk should never reach it.
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    // tmp/inner/.git/ creates a repo boundary — walk must stop here.
    await mkdir(join(tmp, "inner", ".git"), { recursive: true });
    await mkdir(join(tmp, "inner", "member"), { recursive: true });
    await writeFile(
      join(tmp, "inner", "member", "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@1" }),
    );

    const result = await detectContext(join(tmp, "inner", "member"));

    expect(result).toEqual({ kind: "member", platformDir: null, platformVersion: null });
  });

  test("kind='member' walk reaches fs root cleanly without infinite loop", async () => {
    // Deeply nested member with no spec-engine/ and no .git/ in any ancestor.
    // The walk must terminate at the fs root via parent === current.
    await mkdir(join(tmp, "a", "b", "c", "d", "member"), { recursive: true });
    await writeFile(
      join(tmp, "a", "b", "c", "d", "member", "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@1" }),
    );

    const start = Date.now();
    const result = await detectContext(join(tmp, "a", "b", "c", "d", "member"));
    const elapsed = Date.now() - start;

    expect(result).toEqual({ kind: "member", platformDir: null, platformVersion: null });
    expect(elapsed).toBeLessThan(1000);
  });

  test("kind='loose' walks upward and finds platform (Open Question 3 resolution)", async () => {
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    await mkdir(join(tmp, "scratch"), { recursive: true });

    const result = await detectContext(join(tmp, "scratch"));

    expect(result).toEqual({ kind: "loose", platformDir: tmp, platformVersion: 1 });
  });

  test("kind='loose' with no platform up the tree returns null", async () => {
    await mkdir(join(tmp, "anything"), { recursive: true });

    const result = await detectContext(join(tmp, "anything"));

    expect(result).toEqual({ kind: "loose", platformDir: null, platformVersion: null });
  });

  test("INIT-07 termination order: spec-engine/ wins over .git/ at the same level", async () => {
    // Both spec-engine/ AND .git/ exist at tmp. Per Pattern 2 the (a) check
    // (spec-engine/ child as dir) runs BEFORE the (b) check (.git/ child).
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    await mkdir(join(tmp, ".git"), { recursive: true });
    await mkdir(join(tmp, "member"), { recursive: true });
    await writeFile(
      join(tmp, "member", "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@1" }),
    );

    const result = await detectContext(join(tmp, "member"));

    expect(result).toEqual({ kind: "member", platformDir: tmp, platformVersion: 1 });
  });

  test("stray retired spec-engine.platform.json is IGNORED — version stays derived (RED-85)", async () => {
    // An authored counter beside derived domain versions is the retired
    // two-sources-of-truth shape: the file must contribute NOTHING, even
    // when it claims a higher version than the domains derive.
    await writeVersionedDomain(tmp, "ALPHA", 2);
    await writeFile(
      join(tmp, "spec-engine", "spec-engine.platform.json"),
      JSON.stringify({ version: 9 }),
    );

    const result = await detectContext(tmp);

    expect(result).toEqual({ kind: "platform", platformDir: tmp, platformVersion: 2 });
  });

  test("malformed stray manifest never throws — it is not parsed at all (RED-85)", async () => {
    await writeVersionedDomain(tmp, "ALPHA", 2);
    await writeFile(join(tmp, "spec-engine", "spec-engine.platform.json"), "{not valid json");

    const result = await detectContext(tmp);

    expect(result).toEqual({ kind: "platform", platformDir: tmp, platformVersion: 2 });
  });

  test("a malformed domain SPEC.json contributes nothing — remaining domains still derive (RED-85)", async () => {
    // The loud INVALID_DOMAIN_FILE reject belongs to the parse stage
    // (spec index / spec check), not to context detection: derivation is
    // lenient so `spec init` still resolves a pin from the healthy domains.
    await writeVersionedDomain(tmp, "ALPHA", 3);
    await mkdir(join(tmp, "spec-engine", "BROKEN"), { recursive: true });
    await writeFile(join(tmp, "spec-engine", "BROKEN", "SPEC.json"), "{not valid json");

    const result = await detectContext(tmp);

    expect(result).toEqual({ kind: "platform", platformDir: tmp, platformVersion: 3 });
  });

  test("findPlatformDirUpward unit: returns dir directly when startDir itself contains spec-engine/", async () => {
    await mkdir(join(tmp, "spec-engine"), { recursive: true });

    const result = findPlatformDirUpward(tmp);

    expect(result).toBe(tmp);
  });
});
