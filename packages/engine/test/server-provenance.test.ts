// packages/engine/test/server-provenance.test.ts
//
// Phase 16 Plan 02 / Task 1 (PWEB-01) — lock the `/api/provenance` routes at
// the Hono seam. Harness mirrors server-relations.test.ts (cloneFixture →
// openStorage → runIndex once in beforeAll; fresh Hono app per test). The
// platform-fixture carries `**Issues:**` provenance fields (BILLING-009 etc.),
// so content assertions live here.
//
// Contract:
//   - GET /api/provenance              → 200 JSON ProvenanceMatrixRow[],
//                                         deep-equals storage.provenanceMatrix().
//   - GET /api/provenance/:issue       → 200 JSON rows for that bound issue
//                                         (issue is a bound param VALUE, never
//                                         interpolated).
//   - GET /api/provenance?resolve=1    → 200 text/plain decorated text. With no
//                                         SPEC_TRACKER_TOKEN the text degrades to
//                                         the bare ids + the "set SPEC_TRACKER_TOKEN"
//                                         hint (deterministic, no network).
//   - GET /api/provenance?resolve=bogus → 400, never 500 (mirrors format=mermaid).
//   - Cache-Control: no-store applies (derived-index staleness footgun).
//
// The `?resolve=1` resolution happens ENGINE-SIDE (server/api.ts imports
// resolveAndCache from provenance/resolve.ts — a surface-layer module). The
// webapp never resolves; it reads this decorated-text seam.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProvenanceMatrixRow, Storage } from "@spec-engine/shared";
import { Hono } from "hono";
import { runIndex } from "../src/indexer/pipeline";
import { TOKEN_HINT } from "../src/provenance/format";
import { mountApi } from "../src/server/api";
import { openStorage } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let storage: Storage;

beforeAll(async () => {
  clone = cloneFixture(FIXTURE);
  // Strip any stale committed-index leftovers — the derived DB owns nothing.
  rmSync(join(clone, ".spec-engine"), { recursive: true, force: true });
  storage = openStorage(join(clone, ".spec-engine", "index.sqlite"));
  await runIndex({ platformDir: clone, storage });
});

afterAll(() => {
  storage.close();
  rmSync(clone, { recursive: true, force: true });
});

function buildApp(): Hono {
  const app = new Hono();
  // platformDir threaded so resolveAndCache writes the sidecar under the clone,
  // not the test runner's cwd. The token is unset, so resolution degrades and
  // makes no network call regardless.
  mountApi(app, storage, clone);
  return app;
}

describe("/api/provenance", () => {
  test("GET /api/provenance → 200 JSON deep-equals storage.provenanceMatrix()", async () => {
    const res = await buildApp().request("/api/provenance");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const rows = (await res.json()) as ProvenanceMatrixRow[];
    expect(rows).toEqual(storage.provenanceMatrix());
    // Sanity: the fixture has provenance links to assert against.
    expect(rows.length).toBeGreaterThan(0);
  });

  test("GET /api/provenance/:issue → 200 JSON rows for the bound issue filter", async () => {
    const res = await buildApp().request("/api/provenance/ENG-1432");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const rows = (await res.json()) as ProvenanceMatrixRow[];
    expect(rows).toEqual(storage.provenanceByIssue("ENG-1432"));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // Every returned row is linked to the requested opaque issue id.
    for (const row of rows) {
      expect(row.issue_id).toBe("ENG-1432");
    }
  });

  test("GET /api/provenance?resolve=1 (token unset) → 200 text/plain degraded decorated text", async () => {
    const res = await buildApp().request("/api/provenance?resolve=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    // Degraded path: bare opaque ids + the token hint on every link line.
    expect(body).toContain("ENG-1432");
    expect(body).toContain(TOKEN_HINT);
  });

  test("GET /api/provenance?resolve=bogus → 400 JSON error, never 500", async () => {
    const res = await buildApp().request("/api/provenance?resolve=bogus");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("resolve");
  });

  test("Cache-Control: no-store is set (JSON, reverse-lookup, and decorated-text projections)", async () => {
    const app = buildApp();
    const jsonRes = await app.request("/api/provenance");
    expect(jsonRes.headers.get("cache-control")).toBe("no-store");
    const issueRes = await app.request("/api/provenance/ENG-1432");
    expect(issueRes.headers.get("cache-control")).toBe("no-store");
    const textRes = await app.request("/api/provenance?resolve=1");
    expect(textRes.headers.get("cache-control")).toBe("no-store");
  });
});
