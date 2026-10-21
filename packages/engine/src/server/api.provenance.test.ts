import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProvenanceMatrixRow, Storage } from "@spec-engine/shared";
import { Hono } from "hono";
import { runIndex } from "../indexer/pipeline";
import { TOKEN_HINT } from "../provenance/format";
import { openStorage } from "../storage/sqlite";
import { cloneFixture } from "../testing/cloneFixture";
import { mountApi } from "./api";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let storage: Storage;

let priorFlags: string | undefined;

beforeAll(async () => {
  // The provenance read API is feature-flagged; this suite tests the ON
  // behavior (the OFF 404 is locked in feature-flags.test.ts).
  priorFlags = process.env.SPEC_FLAGS;
  process.env.SPEC_FLAGS = "provenance";
  clone = cloneFixture(FIXTURE);
  // Strip any stale committed-index leftovers — the derived DB owns nothing.
  rmSync(join(clone, ".spec-engine"), { recursive: true, force: true });
  storage = openStorage(join(clone, ".spec-engine", "index.sqlite"));
  await runIndex({ platformDir: clone, storage });
});

afterAll(() => {
  if (priorFlags === undefined) delete process.env.SPEC_FLAGS;
  else process.env.SPEC_FLAGS = priorFlags;
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
    expect(rows.length).toBeGreaterThan(0);
  });

  test("GET /api/provenance/by-issue?issue= → 200 JSON rows for the bound issue filter", async () => {
    const res = await buildApp().request("/api/provenance/by-issue?issue=ENG-1432");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const rows = (await res.json()) as ProvenanceMatrixRow[];
    expect(rows).toEqual(storage.provenanceByIssue("ENG-1432"));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.issue_id).toBe("ENG-1432");
    }
  });

  test("GET /api/provenance?resolve=1 (token unset) → 200 text/plain degraded decorated text", async () => {
    const res = await buildApp().request("/api/provenance?resolve=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
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
    const issueRes = await app.request("/api/provenance/by-issue?issue=ENG-1432");
    expect(issueRes.headers.get("cache-control")).toBe("no-store");
    const textRes = await app.request("/api/provenance?resolve=1");
    expect(textRes.headers.get("cache-control")).toBe("no-store");
  });
});
