// packages/webapp/test/filesystem-isolation.test.ts
//
// Plan 05-05 / Task 2 — the canonical SERV-03 / Invariant #5 proof. Once
// `spec index` has populated the derived DB, the webapp MUST NOT read
// the canonical spec files or member source files on disk. The data
// path goes through the Storage seam only.
//
// This is the integration-layer twin of plan 05-04's import-fence test
// (which catches an `import { readFileSync } from "node:fs"` at source
// review time): the import fence proves the webapp source CAN'T touch
// the FS; this test proves that even when the FS is wiped, the rendered
// pages and `/api/coverage` response are bitwise identical to the
// pre-deletion baseline.
//
// Sequence per Test 1:
//   1. cloneFixture → openStorage → runIndex (real index against the clone)
//   2. Compose Hono app: mountApi(app, storage) + mountWebapp(app)
//   3. Capture BEFORE: /api/coverage rows, / HTML body, /propagation HTML body
//   4. rmSync the canonical spec files AND a member-tagged source file
//   5. Capture AFTER: same routes, same calls
//   6. Assert bitwise equality (rows.toEqual + html.toBe substrings)
//
// TEST-ONLY engine imports — production webapp source is hermetic
// (enforced by `packages/webapp/biome.json`'s scoped `src/**/*.ts`
// override + the defense-in-depth grep test in `import-fence.test.ts`).
// Mirrors the harness pattern from `packages/webapp/test/pages.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { runIndex } from "@spec-engine/spec-engine/src/indexer/pipeline";
import { mountApi } from "@spec-engine/spec-engine/src/server/api";
import { openStorage } from "@spec-engine/spec-engine/src/storage/sqlite";
import { Hono } from "hono";
import { mountWebapp } from "../src/server";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let storage: Storage;

beforeEach(async () => {
  clone = cloneFixture(FIXTURE);
  storage = openStorage(join(clone, ".spec-engine", "index.sqlite"));
  await runIndex({ platformDir: clone, storage });
});

afterEach(() => {
  storage.close();
  rmSync(clone, { recursive: true, force: true });
});

function buildApp(): Hono {
  const app = new Hono();
  mountApi(app, storage);
  mountWebapp(app);
  return app;
}

describe("filesystem isolation (SERV-03 / Invariant #5)", () => {
  // --- Test 1 — canonical proof: delete spec files + member source, prove
  //              /api/coverage AND SSR pages are bitwise unchanged.
  test("after rmSync of spec files + member source, /api/coverage and SSR pages render identically", async () => {
    const app = buildApp();

    // ----- BEFORE -----
    const beforeCoverage = await app.request("/api/coverage");
    expect(beforeCoverage.status).toBe(200);
    const beforeRows = await beforeCoverage.json();

    const beforeIndex = await app.request("/");
    expect(beforeIndex.status).toBe(200);
    const beforeIndexBody = await beforeIndex.text();

    const beforePropagation = await app.request("/propagation/BILLING-009");
    expect(beforePropagation.status).toBe(200);
    const beforePropagationBody = await beforePropagation.text();

    // Negative-control half (Test 3 baked in): the BEFORE response must
    // be non-trivial, else "empty == empty" would falsely satisfy the
    // equality assertion below.
    expect(Array.isArray(beforeRows)).toBe(true);
    expect(beforeRows.length).toBeGreaterThan(0);
    expect(beforeIndexBody).toContain("BILLING-009");

    // ----- WIPE THE FILESYSTEM (the whole point of SERV-03) -----
    // 1. Spec files — both BILLING and AUTH SPEC.md
    const billingSpec = join(clone, "spec-engine", "BILLING", "SPEC.md");
    const authSpec = join(clone, "spec-engine", "AUTH", "SPEC.md");
    rmSync(billingSpec, { force: true });
    rmSync(authSpec, { force: true });
    expect(existsSync(billingSpec)).toBe(false);
    expect(existsSync(authSpec)).toBe(false);

    // 2. Member-tagged source file — `api/src/renew.ts` carries the
    //    BILLING-009 @spec tag in the fixture. The webapp must NOT
    //    re-read it to render coverage or propagation rows.
    const memberSrc = join(clone, "api", "src", "renew.ts");
    rmSync(memberSrc, { force: true });
    expect(existsSync(memberSrc)).toBe(false);

    // ----- AFTER -----
    const afterCoverage = await app.request("/api/coverage");
    expect(afterCoverage.status).toBe(200);
    const afterRows = await afterCoverage.json();

    const afterIndex = await app.request("/");
    expect(afterIndex.status).toBe(200);
    const afterIndexBody = await afterIndex.text();

    const afterPropagation = await app.request("/propagation/BILLING-009");
    expect(afterPropagation.status).toBe(200);
    const afterPropagationBody = await afterPropagation.text();

    // ----- ASSERT: bitwise equality across all three responses -----
    expect(afterRows).toEqual(beforeRows);
    expect(afterIndexBody).toBe(beforeIndexBody);
    expect(afterPropagationBody).toBe(beforePropagationBody);

    // Sanity: the AFTER body still shows the fixture content the user
    // would expect, even though the source files are gone.
    expect(afterIndexBody).toContain("BILLING-009");
    expect(afterPropagationBody).toContain("ON_PREDECESSOR");
  });

  // --- Test 2 — /api/resolve also goes DB-only (RSLV-01 still resolves
  //              even though the tagged file is gone from disk).
  test("/api/resolve still returns the indexed requirements after member source is rmSync'd", async () => {
    const app = buildApp();

    // Delete the tagged member file BEFORE the request — the resolver
    // must read tags from the DB, not re-scan the FS.
    const memberSrc = join(clone, "api", "src", "renew.ts");
    rmSync(memberSrc, { force: true });
    expect(existsSync(memberSrc)).toBe(false);

    const res = await app.request("/api/resolve?files=api/src/renew.ts");
    expect(res.status).toBe(200);
    const reqs = (await res.json()) as Array<{ id: string }>;
    const ids = reqs.map((r) => r.id).sort();
    // The fixture's `api/src/renew.ts` is tagged with BILLING-009 (and
    // historically the superseded BILLING-001 — but the resolver returns
    // the current Active state via the tags table). The canonical pair
    // locked elsewhere (see 05-01 SUMMARY) is BILLING-002 + BILLING-009;
    // assert the renew.ts tags here.
    expect(ids).toContain("BILLING-009");
  });

  // --- Test 3 — explicit negative control. WITHOUT deleting anything,
  //              prove BEFORE is non-empty so Test 1's equality isn't
  //              vacuously satisfied by "empty == empty".
  test("negative control: /api/coverage returns non-empty rows on a freshly indexed clone", async () => {
    const app = buildApp();
    const res = await app.request("/api/coverage");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });
});
