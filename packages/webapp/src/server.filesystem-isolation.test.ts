// Engine imports are test-only: production webapp source is hermetic under
// the webapp biome.json import override and import-fence.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { runIndex } from "@spec-engine/spec-engine/src/indexer/pipeline";
import { mountApi } from "@spec-engine/spec-engine/src/server/api";
import { openStorage } from "@spec-engine/spec-engine/src/storage/sqlite";
import { Hono } from "hono";
import { mountWebapp } from "./server";
import { cloneFixture } from "./testing/cloneFixture";

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

describe("filesystem isolation", () => {
  test("after rmSync of the member source and the SPEC.json files, /api/coverage and SSR pages render identically", async () => {
    const app = buildApp();

    const beforeCoverage = await app.request("/api/coverage");
    expect(beforeCoverage.status).toBe(200);
    const beforeRows = await beforeCoverage.json();

    const beforeIndex = await app.request("/");
    expect(beforeIndex.status).toBe(200);
    const beforeIndexBody = await beforeIndex.text();

    const beforePropagation = await app.request("/propagation/BILLING-009");
    expect(beforePropagation.status).toBe(200);
    const beforePropagationBody = await beforePropagation.text();

    // A non-trivial baseline, or empty == empty would pass the equality below.
    expect(Array.isArray(beforeRows)).toBe(true);
    expect((beforeRows as unknown[]).length).toBeGreaterThan(0);
    expect(beforeIndexBody).toContain("BILLING-009");

    const billingSpec = join(clone, "spec-engine", "BILLING", "SPEC.json");
    const authSpec = join(clone, "spec-engine", "AUTH", "SPEC.json");
    expect(existsSync(billingSpec)).toBe(true);
    expect(existsSync(authSpec)).toBe(true);
    rmSync(billingSpec);
    rmSync(authSpec);
    expect(existsSync(billingSpec)).toBe(false);
    expect(existsSync(authSpec)).toBe(false);

    const memberSrc = join(clone, "api", "src", "renew.ts");
    rmSync(memberSrc, { force: true });
    expect(existsSync(memberSrc)).toBe(false);

    const afterCoverage = await app.request("/api/coverage");
    expect(afterCoverage.status).toBe(200);
    const afterRows = await afterCoverage.json();

    const afterIndex = await app.request("/");
    expect(afterIndex.status).toBe(200);
    const afterIndexBody = await afterIndex.text();

    const afterPropagation = await app.request("/propagation/BILLING-009");
    expect(afterPropagation.status).toBe(200);
    const afterPropagationBody = await afterPropagation.text();

    expect(afterRows).toEqual(beforeRows);
    expect(afterIndexBody).toBe(beforeIndexBody);
    expect(afterPropagationBody).toBe(beforePropagationBody);

    expect(afterIndexBody).toContain("BILLING-009");
    expect(afterPropagationBody).toContain("ON_PREDECESSOR");
  });

  test("/api/resolve still returns the indexed requirements after member source is rmSync'd", async () => {
    const app = buildApp();

    // Deleted first: the resolver must read tags from the DB, not re-scan the FS.
    const memberSrc = join(clone, "api", "src", "renew.ts");
    rmSync(memberSrc, { force: true });
    expect(existsSync(memberSrc)).toBe(false);

    const res = await app.request("/api/resolve?files=api/src/renew.ts");
    expect(res.status).toBe(200);
    const reqs = (await res.json()) as Array<{ id: string }>;
    const ids = reqs.map((r) => r.id).sort();
    expect(ids).toContain("BILLING-009");
  });

  test("negative control: /api/coverage returns non-empty rows on a freshly indexed clone", async () => {
    const app = buildApp();
    const res = await app.request("/api/coverage");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });
});
