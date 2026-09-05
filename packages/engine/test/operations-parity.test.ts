// packages/engine/test/operations-parity.test.ts
//
// One operation, three surfaces. For each operation that has more than one
// front-end, the CLI's in-process path, the HTTP API (in-process Hono
// request), and the MCP server (InMemoryTransport) are driven over the same
// platform and must return the same data, and a write through any of them must
// leave the same envelope on disk.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Storage } from "@spec-engine/shared";
import { Hono } from "hono";
import { runIndex } from "../src/indexer/pipeline";
import { withIndex } from "../src/operations/_index";
import { amend } from "../src/operations/amend";
import { check } from "../src/operations/check";
import { mint } from "../src/operations/mint";
import { coverageReport, propagation, query, reqTags, resolveFiles } from "../src/operations/reads";
import { mountApi } from "../src/server/api";
import { buildMcpServer } from "../src/server/mcp";
import { openStorage } from "../src/storage/sqlite";
import { specTag } from "./fixtures/specTag";

const BILLING = (reqs: unknown[]) =>
  JSON.stringify(
    { key: "BILLING", owner: null, updated: "2026-06-01", scope: "billing", requirements: reqs },
    null,
    2,
  );
const req = (id: string, statement: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "active",
  statement,
  why: "revenue",
  supersedes: null,
  supersededBy: null,
  relates: [],
  livesIn: [],
  issues: [],
  ...extra,
});

let tmp: string;
let platform: string;
let storage: Storage;
let app: Hono;
let client: Client;
let cleanup: (() => Promise<void>) | null = null;
let priorFlags: string | undefined;

async function connectMcp(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(platform);
  await server.connect(serverTransport);
  const c = new Client({ name: "parity", version: "0" });
  await c.connect(clientTransport);
  cleanup = async () => {
    await c.close();
    await server.close();
  };
  return c;
}

async function mcpJson(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  expect(res.isError ?? false).toBe(false);
  return JSON.parse(res.content[0]?.text ?? "null");
}

async function apiJson(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path, init);
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  priorFlags = process.env.SPEC_FLAGS;
  process.env.SPEC_FLAGS = "query,editor";
  tmp = mkdtempSync(join(tmpdir(), "spec-parity-"));
  platform = join(tmp, "platform");
  mkdirSync(join(platform, "spec-engine", "BILLING"), { recursive: true });
  writeFileSync(
    join(platform, "spec-engine", "BILLING", "SPEC.json"),
    BILLING([
      req("BILLING-001", "renewal charges use the current plan price", {
        status: "superseded",
        supersededBy: "BILLING-002",
      }),
      req("BILLING-002", "renewal charges use the plan price at renewal time", {
        supersedes: "BILLING-001",
      }),
      req("BILLING-003", "refunds reverse the original charge"),
    ]),
  );
  mkdirSync(join(platform, "api", "src"), { recursive: true });
  mkdirSync(join(platform, "api", "test"), { recursive: true });
  writeFileSync(join(platform, "api", "spec-engine.member.json"), '{ "specs": "spec-engine@2" }\n');
  writeFileSync(
    join(platform, "api", "src", "renew.ts"),
    `export const renew = 1; ${specTag("BILLING-002")}`,
  );
  writeFileSync(
    join(platform, "api", "test", "renew.test.ts"),
    `export const t = 1; ${specTag("BILLING-002", "unit")}`,
  );
  storage = openStorage(join(platform, ".spec-engine", "index.sqlite"));
  await runIndex({ platformDir: platform, storage });
  app = new Hono();
  mountApi(app, storage, platform);
  client = await connectMcp();
});

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
  storage.close();
  rmSync(tmp, { recursive: true, force: true });
  if (priorFlags === undefined) delete process.env.SPEC_FLAGS;
  else process.env.SPEC_FLAGS = priorFlags;
});

// @spec SCHM-012 integration
describe("read operations answer identically on every surface", () => {
  test("query", async () => {
    const viaCli = await withIndex({ platformDir: platform, build: "fresh" }, (h) => {
      const r = query(h.storage, "renewal", 10);
      return r.ok ? r.hits : null;
    });
    const viaApi = await apiJson("/api/query?q=renewal&limit=10");
    const viaMcp = await mcpJson("spec_query", { text: "renewal", limit: 10 });
    expect(viaCli).not.toBeNull();
    expect(viaApi.status).toBe(200);
    expect(viaApi.body).toEqual(viaCli);
    expect(viaMcp).toEqual(viaCli);
  });

  test("resolve files, reverse resolve, propagation, coverage report", async () => {
    const viaCli = await withIndex({ platformDir: platform, build: "fresh" }, (h) => ({
      files: resolveFiles(h.storage, ["api/src/renew.ts"]).rows,
      tags: reqTags(h.storage, "BILLING-002").rows,
      prop: propagation(h.storage, "BILLING-002").rows,
      report: coverageReport(h.storage).rows,
    }));
    expect((await apiJson("/api/resolve?files=api/src/renew.ts")).body).toEqual(viaCli.files);
    expect((await apiJson("/api/resolve?req=BILLING-002")).body).toEqual(viaCli.tags);
    expect((await apiJson("/api/propagation/BILLING-002")).body).toEqual(viaCli.prop);
    expect((await apiJson("/api/report")).body).toEqual(viaCli.report);
    expect(await mcpJson("spec_resolve", { files: ["api/src/renew.ts"] })).toEqual(viaCli.files);
    expect(await mcpJson("spec_req_tags", { req_id: "BILLING-002" })).toEqual(viaCli.tags);
    expect(await mcpJson("spec_propagation", { req_id: "BILLING-002" })).toEqual(viaCli.prop);
    expect(await mcpJson("spec_coverage_report", {})).toEqual(viaCli.report);
  });

  test("check", async () => {
    const viaCli = await withIndex({ platformDir: platform, build: "reset" }, async (h) => {
      const r = await check({ platformDir: platform }, h.storage);
      return r.ok ? r.diagnostics : null;
    });
    const viaMcp = await mcpJson("spec_check", {});
    expect(viaCli).not.toBeNull();
    expect(viaMcp).toEqual(viaCli);
  });

  test("next id", async () => {
    expect(await mcpJson("spec_next_id", { domain: "bil" })).toEqual({
      domain: "BILLING",
      next_id: "BILLING-004",
    });
  });
});

// @spec SCHM-024 integration
describe("write operations leave the same envelope from every surface", () => {
  const statement = "When a refund is issued, the billing service shall reverse the charge.";

  test("mint: the operation and the HTTP POST write byte-identical entries", async () => {
    const specPath = join(platform, "spec-engine", "BILLING", "SPEC.json");
    const before = await Bun.file(specPath).text();

    const direct = await mint({
      platformDir: platform,
      key: "BILLING",
      statement,
      why: "w",
      livesIn: ["x.ts"],
    });
    expect(direct.ok).toBe(true);
    const afterDirect = await Bun.file(specPath).text();

    writeFileSync(specPath, before);
    const posted = await apiJson("/api/requirements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "BILLING", statement, why: "w", livesIn: "x.ts" }),
    });
    expect(posted.status).toBe(201);
    expect(posted.body).toEqual({ ok: true, id: "BILLING-004" });
    const afterPost = await Bun.file(specPath).text();

    expect(afterPost).toBe(afterDirect);
  });

  test("amend: the operation and the HTTP PUT apply the same field semantics and gates", async () => {
    const specPath = join(platform, "spec-engine", "BILLING", "SPEC.json");
    const before = await Bun.file(specPath).text();
    const fresh = (id: string) =>
      withIndex({ platformDir: platform, build: "fresh" }, (h) =>
        h.storage.listTags({ req_id: id }),
      );

    const direct = await amend(
      { platformDir: platform, id: "BILLING-003", fields: { why: null } },
      fresh,
    );
    expect(direct.ok).toBe(true);
    const afterDirect = await Bun.file(specPath).text();

    writeFileSync(specPath, before);
    const put = await apiJson("/api/requirements/BILLING-003", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ why: null }),
    });
    expect(put.status).toBe(200);
    expect(await Bun.file(specPath).text()).toBe(afterDirect);

    // The shipped gate refuses on both surfaces with the same reason.
    const shipped = await amend(
      { platformDir: platform, id: "BILLING-002", fields: { why: "x" } },
      fresh,
    );
    expect(shipped.ok).toBe(false);
    if (!shipped.ok) expect(shipped.reason).toBe("conflict");
    const putShipped = await apiJson("/api/requirements/BILLING-002", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ why: "x" }),
    });
    expect(putShipped.status).toBe(409);
  });
});
