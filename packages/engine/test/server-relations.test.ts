// packages/engine/test/server-relations.test.ts
//
// RED-17: lock the `/api/relations` route at the Hono seam. Harness
// mirrors server-api.test.ts (cloneFixture → openStorage → runIndex once
// in beforeAll; fresh Hono app per test) but clones relates-fixture —
// platform-fixture has no Relates fields, so content assertions live here.
//
// Contract:
//   - GET /api/relations           → 200 JSON RelationRow[], deterministic
//                                    (from, to) order, broken targets kept.
//   - GET /api/relations?format=mermaid → 200 text/plain mermaid graph —
//     the SAME formatter the CLI uses (one engine, no forked logic); this
//     is the seam the webapp /relations page reads through, since the
//     webapp import fence (D-09) forbids importing @spec-engine/spec-engine directly.
//   - GET /api/relations?format=bogus → 400, never 500.
//   - Cache-Control: no-store applies (derived-index staleness footgun).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RelationRow, Storage } from "@spec-engine/shared";
import { Hono } from "hono";
import { runIndex } from "../src/indexer/pipeline";
import { mountApi } from "../src/server/api";
import { openStorage } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "relates-fixture");

let clone: string;
let storage: Storage;

beforeAll(async () => {
  clone = cloneFixture(FIXTURE);
  // Strip any stale committed-index leftovers — the derived DB owns
  // nothing; this run's index is built fresh from the cloned spec.
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
  mountApi(app, storage);
  return app;
}

describe("/api/relations", () => {
  test("GET /api/relations → 200 JSON rows in deterministic (from, to) order", async () => {
    const res = await buildApp().request("/api/relations");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const rows = (await res.json()) as RelationRow[];
    expect(rows.map((r) => `${r.from_id}>${r.to_id}`)).toEqual([
      "REL-001>REL-003",
      "REL-003>REL-002",
      "REL-003>REL-999", // broken target deliberately kept (Invariant #4)
    ]);
  });

  test("GET /api/relations?format=mermaid → 200 text/plain mermaid graph", async () => {
    const res = await buildApp().request("/api/relations?format=mermaid");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body.startsWith("graph LR")).toBe(true);
    expect(body).toContain('REL_001["REL-001"]');
    expect(body).toContain("REL_001 --- REL_003");
    expect(body).toContain("REL_002 --- REL_003");
    expect(body).toContain("REL_003 --- REL_999");
  });

  test("GET /api/relations?format=bogus → 400 with a JSON error, never 500", async () => {
    const res = await buildApp().request("/api/relations?format=bogus");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("format");
  });

  test("Cache-Control: no-store is set (both JSON and mermaid projections)", async () => {
    const app = buildApp();
    const jsonRes = await app.request("/api/relations");
    expect(jsonRes.headers.get("cache-control")).toBe("no-store");
    const mermaidRes = await app.request("/api/relations?format=mermaid");
    expect(mermaidRes.headers.get("cache-control")).toBe("no-store");
  });
});
