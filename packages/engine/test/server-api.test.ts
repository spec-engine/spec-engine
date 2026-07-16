// packages/engine/test/server-api.test.ts
//
// Plan 05-03 / Task 2 — lock SERV-01 + SERV-03 at the Hono `/api/*` seam.
// `mountApi(app, storage)` (server/api.ts) is the single HTTP surface the
// webapp reads through; if a future refactor breaks route shapes, error
// translation, FTS5 grammar catching, the V12 path-shape guard, or the
// Cache-Control header, this file fails before any rendered output churns.
//
// Pattern: Pattern 6 from 05-RESEARCH — `app.request(path)` is the canonical
// in-process Hono testing API; no Bun.serve, no port binding, no async
// cleanup beyond storage.close + tmpdir rm.
//
// Harness mirrors storage-resolve.test.ts: one cloneFixture+runIndex'd
// storage shared by every test via beforeAll/afterAll. Each test
// constructs a fresh Hono app and calls mountApi(app, storage) — the same
// storage instance is safe to share because every `/api/*` route is
// read-only (Pitfall noted: no concurrent writes here).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FILES_MAX, type Storage } from "@spec-engine/shared";
import { Hono } from "hono";
import { runIndex } from "../src/indexer/pipeline";
import { mountApi } from "../src/server/api";
import { openStorage } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let storage: Storage;

beforeAll(async () => {
  clone = cloneFixture(FIXTURE);
  storage = openStorage(join(clone, ".spec-engine", "index.sqlite"));
  await runIndex({ platformDir: clone, storage });
});

afterAll(() => {
  storage.close();
  rmSync(clone, { recursive: true, force: true });
});

/** Build a fresh Hono app with `/api/*` mounted against the shared fixture storage. */
function buildApp(): Hono {
  const app = new Hono();
  mountApi(app, storage);
  return app;
}

// @spec SERV-002
describe("mountApi (/api/* Hono surface)", () => {
  // --- /api/coverage --------------------------------------------------------

  test("GET /api/coverage → 200 array containing BILLING + AUTH rows", async () => {
    const app = buildApp();
    const res = await app.request("/api/coverage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ req_id: string }>;
    expect(Array.isArray(body)).toBe(true);
    const reqIds = new Set(body.map((r) => r.req_id));
    expect(reqIds.has("AUTH-001")).toBe(true);
    // At least one BILLING-* row must surface (covering all member repos).
    expect([...reqIds].some((id) => id.startsWith("BILLING-"))).toBe(true);
  });

  test("GET /api/coverage headers include Cache-Control: no-store (RESEARCH Open Q5)", async () => {
    const app = buildApp();
    const res = await app.request("/api/coverage");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // --- /api/repos -----------------------------------------------------------

  test("GET /api/repos → 200 array of member repos with name + path + pin", async () => {
    const app = buildApp();
    const res = await app.request("/api/repos");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      name: string;
      path: string;
      pinned_spec_version: number;
    }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    // Every row carries the fields the Setup page renders.
    for (const r of body) {
      expect(typeof r.name).toBe("string");
      expect(typeof r.path).toBe("string");
      expect(typeof r.pinned_spec_version).toBe("number");
    }
  });

  // --- /api/platform --------------------------------------------------------

  test("GET /api/platform → 200 with the derived platform version (RED-85)", async () => {
    const app = buildApp();
    const res = await app.request("/api/platform");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      source: string;
    };
    // Derived at request time: max domain version across the fixture's
    // SPEC.json files — the retired manifest contributes nothing.
    expect(body.source).toBe("derived");
    expect(typeof body.version).toBe("number");
    expect(body.version).toBeGreaterThan(0);
  });

  // --- /api/requirements ----------------------------------------------------

  test("GET /api/requirements → 200 array of 5 requirements", async () => {
    const app = buildApp();
    const res = await app.request("/api/requirements");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.length).toBe(5);
    const ids = body.map((r) => r.id).sort();
    expect(ids).toEqual(["AUTH-001", "BILLING-001", "BILLING-002", "BILLING-007", "BILLING-009"]);
  });

  test("GET /api/requirements?key=BILLING → 200, length 4", async () => {
    const app = buildApp();
    const res = await app.request("/api/requirements?key=BILLING");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; key: string }>;
    expect(body.length).toBe(4);
    for (const r of body) expect(r.key).toBe("BILLING");
  });

  test("GET /api/requirements?status=Superseded → 200, length 1, BILLING-001", async () => {
    const app = buildApp();
    const res = await app.request("/api/requirements?status=Superseded");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; status: string }>;
    expect(body.length).toBe(1);
    expect(body[0]?.id).toBe("BILLING-001");
    expect(body[0]?.status).toBe("Superseded");
  });

  test("GET /api/requirements?status=Bogus → 400 with whitelist error message", async () => {
    const app = buildApp();
    const res = await app.request("/api/requirements?status=Bogus");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Active");
    expect(body.error).toContain("Superseded");
  });

  // --- /api/requirements/:id ------------------------------------------------

  test("GET /api/requirements/BILLING-009 → 200 with row", async () => {
    const app = buildApp();
    const res = await app.request("/api/requirements/BILLING-009");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; text: string };
    expect(body.id).toBe("BILLING-009");
    expect(body.text).toContain("renews");
  });

  test("GET /api/requirements/NOPE-404 → 404 with error body", async () => {
    const app = buildApp();
    const res = await app.request("/api/requirements/NOPE-404");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not found");
  });

  // --- /api/propagation/:id -------------------------------------------------

  test("GET /api/propagation/BILLING-009 → 200, length 3 (admin/api/mobile)", async () => {
    const app = buildApp();
    const res = await app.request("/api/propagation/BILLING-009");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ repo: string }>;
    expect(body.length).toBe(3);
    expect(body.map((r) => r.repo)).toEqual(["admin", "api", "mobile"]);
  });

  // --- /api/query -----------------------------------------------------------

  test("GET /api/query?q=renewal%20charge → 200, top hit BILLING-009", async () => {
    const app = buildApp();
    const res = await app.request("/api/query?q=renewal%20charge");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ req_id: string }>;
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0]?.req_id).toBe("BILLING-009");
  });

  test("GET /api/query (no q) → 400", async () => {
    const app = buildApp();
    const res = await app.request("/api/query");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("q");
  });

  test("GET /api/query?q=test&limit=abc → 400 (non-integer)", async () => {
    const app = buildApp();
    const res = await app.request("/api/query?q=test&limit=abc");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("limit");
  });

  test("GET /api/query?q=test&limit=1001 → 400 (out of range)", async () => {
    const app = buildApp();
    const res = await app.request("/api/query?q=test&limit=1001");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("limit");
  });

  test("GET /api/query?q=AND%20OR → 400 with FTS5 syntax error message (Pitfall 8; canonical input from fts.test.ts)", async () => {
    // `"AND OR"` is the canonical known-bad FTS5 grammar input locked by
    // Phase 4 plan 04-03 test 5 (packages/engine/test/fts.test.ts:104-115).
    // Reuse verbatim — do NOT invent a new bad input.
    const app = buildApp();
    const res = await app.request("/api/query?q=AND%20OR");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // Contract: the error body identifies this as an FTS5 grammar error so
    // a future webapp client can surface a useful hint. The substring is
    // the typed prefix raised by storage.searchFts (sqlite.ts:457).
    expect(body.error).toContain("FTS5");
  });

  // --- /api/resolve ---------------------------------------------------------

  test("GET /api/resolve?files=api/src/renew.ts&files=api/src/charge.ts → 200, BILLING-002 + BILLING-009 in (key,seq) order", async () => {
    const app = buildApp();
    const res = await app.request("/api/resolve?files=api/src/renew.ts&files=api/src/charge.ts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.length).toBe(2);
    // Storage already sorts by (key, seq): BILLING-002 (seq=2) before BILLING-009 (seq=9).
    expect(body.map((r) => r.id)).toEqual(["BILLING-002", "BILLING-009"]);
  });

  test("GET /api/resolve (no files) → 400", async () => {
    const app = buildApp();
    const res = await app.request("/api/resolve");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("files");
  });

  test("GET /api/resolve?files=../etc/passwd → 400 with 'platform-relative' message (V12 shape guard)", async () => {
    const app = buildApp();
    const res = await app.request("/api/resolve?files=..%2Fetc%2Fpasswd");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("platform-relative");
  });

  test("GET /api/resolve?files=/etc/passwd → 400 (leading slash rejected)", async () => {
    const app = buildApp();
    const res = await app.request("/api/resolve?files=%2Fetc%2Fpasswd");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("platform-relative");
  });

  // --- /api/resolve?req= (reverse, mirrors CLI `spec resolve --req`) --------

  test("GET /api/resolve?req=BILLING-009 → 200, tag sites for that requirement", async () => {
    const app = buildApp();
    const res = await app.request("/api/resolve?req=BILLING-009");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      req_id: string;
      repo: string;
      file: string;
      line: number;
      kind: string;
    }>;
    expect(body.length).toBeGreaterThan(0);
    // Every row belongs to the queried requirement; rows are the ReqTagRow
    // shape (no AUTOINCREMENT id leaked).
    for (const row of body) {
      expect(row.req_id).toBe("BILLING-009");
      expect(typeof row.file).toBe("string");
      expect(typeof row.line).toBe("number");
      expect(row).not.toHaveProperty("id");
    }
    // Sorted by (repo, file, line) — byte-stable, same as the CLI.
    const keys = body.map((r) => `${r.repo} ${r.file} ${r.line}`);
    expect(keys).toEqual([...keys].sort());
  });

  test("GET /api/resolve?req=NOPE-404 → 200 with [] (unknown id, not an error)", async () => {
    const app = buildApp();
    const res = await app.request("/api/resolve?req=NOPE-404");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("GET /api/resolve?req=not-an-id → 400 (must be KEY-NNN)", async () => {
    const app = buildApp();
    const res = await app.request("/api/resolve?req=not-an-id");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("KEY-NNN");
  });

  test("GET /api/resolve?req=BILLING-009&files=x.ts → 400 (mutually exclusive)", async () => {
    const app = buildApp();
    const res = await app.request("/api/resolve?req=BILLING-009&files=x.ts");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not both");
  });

  // --- RED-14 dead-end audit -----------------------------------------------

  test("GET /api/resolve with > FILES_MAX files → 400 with cap message (RED-14)", async () => {
    const app = buildApp();
    const qs = Array.from({ length: FILES_MAX + 1 }, (_, i) => `files=f${i}.ts`).join("&");
    const res = await app.request(`/api/resolve?${qs}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(`max ${FILES_MAX}`);
  });

  // --- RED-18: /api/resolve in self-member (rung-1) mode ------------------

  test("GET /api/resolve?files=src/orders.ts against a rung-1 index → 200 with ORDERS-001 + ORDERS-002 (RED-18)", async () => {
    // Same behavior as the CLI (acceptance criterion 3): the natural
    // platform-relative path must resolve even though rung-1 tags are
    // stored with the repo-basename prefix. The route shares the storage
    // seam with the CLI, so this locks the HTTP surface explicitly.
    const fixture = resolve(import.meta.dir, "..", "..", "..", "fixtures", "single-repo-fixture");
    const tmp = mkdtempSync(join(tmpdir(), "spec-api-rung1-"));
    const rung1 = openStorage(join(tmp, "index.sqlite"));
    try {
      await runIndex({ platformDir: fixture, storage: rung1 });
      const app = new Hono();
      mountApi(app, rung1);
      const res = await app.request("/api/resolve?files=src/orders.ts");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ id: string }>;
      expect(body.map((r) => r.id)).toEqual(["ORDERS-001", "ORDERS-002"]);
    } finally {
      rung1.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("non-FTS storage error in /api/query rethrows → 500, NOT a sanitized 400 (RED-14)", async () => {
    // Only the typed FTS5-syntax error translates to 400; any other storage
    // failure must escape the catch so Hono surfaces a 500 — a closed DB
    // handle is the cheapest deterministic non-FTS failure.
    const dead = openStorage(join(clone, ".spec-engine", "index.sqlite"));
    dead.close();
    const app = new Hono();
    mountApi(app, dead);
    const res = await app.request("/api/query?q=renewal");
    expect(res.status).toBe(500);
  });
});

// ----------------------------------------------------------------------------
// W1 (webapp coverage report) — /api/report: per-domain rollup over Active
// requirements, served from the shared buildCoverageReport over the same
// coverage VIEW /api/coverage reads (one engine, one rollup).
// ----------------------------------------------------------------------------

describe("GET /api/report (W1)", () => {
  test("returns one sorted row per domain with the fixture's known counts", async () => {
    const app = new Hono();
    mountApi(app, storage);
    const res = await app.request("/api/report");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    // Canonical fixture: AUTH-001 Active uncovered; BILLING-001 Superseded
    // (excluded); BILLING-002 Active src-only; BILLING-007 + BILLING-009
    // Active src+test.
    expect(rows).toEqual([
      { domain: "AUTH", active: 1, implemented: 0, verified: 0, orphans: 1, unverified: 0 },
      { domain: "BILLING", active: 3, implemented: 3, verified: 2, orphans: 0, unverified: 1 },
    ]);
  });

  test("includes Cache-Control: no-store like the other read routes", async () => {
    const app = new Hono();
    mountApi(app, storage);
    const res = await app.request("/api/report");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
