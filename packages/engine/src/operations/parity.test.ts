// packages/engine/src/operations/parity.test.ts
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
import { deprecateCommand } from "../commands/deprecate";
import { moveCommand } from "../commands/move";
import { supersedeCommand } from "../commands/supersede";
import { termCommand } from "../commands/term";
import { runIndex } from "../indexer/pipeline";
import { sortRelations } from "../relations/format";
import { mountApi } from "../server/api";
import { buildMcpServer } from "../server/mcp";
import { openStorage } from "../storage/sqlite";
import { specTag } from "../testing/specTag";
import { coldFreshTags, withIndex } from "./_index";
import { amend } from "./amend";
import { check } from "./check";
import { deprecate } from "./deprecate";
import { mint } from "./mint";
import { move } from "./move";
import {
  coverageMatrix,
  coverageReport,
  propagation,
  provenance,
  query,
  relations,
  reqTags,
  resolveFiles,
} from "./reads";
import { supersede } from "./supersede";
import { confirmTerm, mintTerm, reviseTerm } from "./term";

const BILLING = (reqs: unknown[]) =>
  JSON.stringify(
    { key: "BILLING", owner: null, updated: "2026-06-01", scope: "billing", requirements: reqs },
    null,
    2,
  );
const envelope = (key: string, extra: Record<string, unknown>, reqs: unknown[]) =>
  `${JSON.stringify({ key, owner: null, updated: "2026-06-01", ...extra, requirements: reqs }, null, 2)}\n`;
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
  process.env.SPEC_FLAGS = "query,editor,relations,provenance";
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
        relates: ["BILLING-003"],
        issues: [{ role: "created", id: "ENG-1" }],
      }),
      req("BILLING-003", "refunds reverse the original charge", {
        cites: [{ term: "TERM-001", pinned: 1 }],
      }),
    ]),
  );
  mkdirSync(join(platform, "spec-engine", "AUTH"), { recursive: true });
  writeFileSync(join(platform, "spec-engine", "AUTH", "SPEC.json"), envelope("AUTH", {}, []));
  mkdirSync(join(platform, "spec-engine", "TERM"), { recursive: true });
  writeFileSync(
    join(platform, "spec-engine", "TERM", "SPEC.json"),
    envelope("TERM", { specVersion: 1 }, [
      {
        ...req("TERM-001", "the price a plan charges at renewal", { why: null }),
        term: "renewal price",
        aliases: [],
        cites: [],
        changedAtVersion: 1,
      },
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

  test("coverage matrix, relations, provenance", async () => {
    const viaCli = await withIndex({ platformDir: platform, build: "fresh" }, (h) => ({
      coverage: coverageMatrix(h.storage).rows,
      relations: sortRelations(relations(h.storage).rows),
      provenance: provenance(h.storage).rows,
      byIssue: provenance(h.storage, "ENG-1").rows,
    }));
    expect(viaCli.relations).toHaveLength(1);
    expect(viaCli.byIssue).toHaveLength(1);
    expect((await apiJson("/api/coverage")).body).toEqual(viaCli.coverage);
    expect((await apiJson("/api/relations")).body).toEqual(viaCli.relations);
    expect((await apiJson("/api/provenance")).body).toEqual(viaCli.provenance);
    expect((await apiJson("/api/provenance/by-issue?issue=ENG-1")).body).toEqual(viaCli.byIssue);
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

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const cliRun = (cmd: unknown) => (cmd as { run: RunFn }).run;

/**
 * Run a command's `run` with stdout and stderr captured and `process.exit`
 * turned into a thrown error, so a refusal fails the test instead of the runner.
 */
async function runCli(cmd: unknown, args: Record<string, unknown>): Promise<void> {
  const log = console.log;
  const err = console.error;
  const exit = process.exit;
  const errs: string[] = [];
  console.log = () => {};
  console.error = (...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  };
  process.exit = ((code: number) => {
    throw new Error(`process.exit(${code}): ${errs.join("\n")}`);
  }) as typeof process.exit;
  try {
    await cliRun(cmd)({ args: { platformDir: platform, ...args }, rawArgs: [] });
  } finally {
    console.log = log;
    console.error = err;
    process.exit = exit;
  }
}

const specFile = (key: string) => join(platform, "spec-engine", key, "SPEC.json");
const read = (key: string) => Bun.file(specFile(key)).text();

/**
 * Run the same write through each surface from the same starting envelope
 * and return what each left on disk (one snapshot per key, per surface).
 */
async function writeThrough(
  keys: string[],
  surfaces: Record<string, () => Promise<void>>,
): Promise<Record<string, string[]>> {
  const before = await Promise.all(keys.map(read));
  const out: Record<string, string[]> = {};
  for (const [name, run] of Object.entries(surfaces)) {
    for (const [i, k] of keys.entries()) writeFileSync(specFile(k), before[i] as string);
    await run();
    out[name] = await Promise.all(keys.map(read));
  }
  return out;
}

function expectAllEqual(snapshots: Record<string, string[]>): void {
  const names = Object.keys(snapshots);
  const reference = snapshots[names[0] as string];
  for (const name of names.slice(1)) {
    expect(snapshots[name], `${name} differs from ${names[0]}`).toEqual(reference);
  }
}

// @spec SCHM-024 integration
describe("write operations leave the same envelope from every surface", () => {
  const statement = "When a refund is issued, the billing service shall reverse the charge.";
  const apiHeaders = { "content-type": "application/json" };
  const fresh = () => coldFreshTags(platform);

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
      headers: apiHeaders,
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

    const direct = await amend(
      { platformDir: platform, id: "BILLING-003", fields: { why: null } },
      fresh(),
    );
    expect(direct.ok).toBe(true);
    const afterDirect = await Bun.file(specPath).text();

    writeFileSync(specPath, before);
    const put = await apiJson("/api/requirements/BILLING-003", {
      method: "PUT",
      headers: apiHeaders,
      body: JSON.stringify({ why: null }),
    });
    expect(put.status).toBe(200);
    expect(await Bun.file(specPath).text()).toBe(afterDirect);

    // The shipped gate refuses on both surfaces with the same reason.
    const shipped = await amend(
      { platformDir: platform, id: "BILLING-002", fields: { why: "x" } },
      fresh(),
    );
    expect(shipped.ok).toBe(false);
    if (!shipped.ok) expect(shipped.reason).toBe("conflict");
    const putShipped = await apiJson("/api/requirements/BILLING-002", {
      method: "PUT",
      headers: apiHeaders,
      body: JSON.stringify({ why: "x" }),
    });
    expect(putShipped.status).toBe(409);
  });

  // @spec REQ-038 integration
  test("supersede: operation, CLI, HTTP POST, and MCP write the same envelope and worklist", async () => {
    const successor = "When a renewal is charged, the billing service shall use the plan price.";
    const results: Record<string, unknown> = {};
    const snapshots = await writeThrough(["BILLING"], {
      operation: async () => {
        const r = await supersede(
          { platformDir: platform, id: "BILLING-002", statement: successor, why: "w" },
          fresh(),
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
          results.operation = {
            old_id: r.oldId,
            new_id: r.newId,
            file: r.file,
            spec_version: r.specVersion,
            retag: r.retag,
          };
        }
      },
      cli: () => runCli(supersedeCommand, { id: "BILLING-002", text: successor, why: "w" }),
      api: async () => {
        const res = await apiJson("/api/requirements/BILLING-002/supersede", {
          method: "POST",
          headers: apiHeaders,
          body: JSON.stringify({ statement: successor, why: "w" }),
        });
        expect(res.status).toBe(201);
        const { ok, ...rest } = res.body as Record<string, unknown>;
        expect(ok).toBe(true);
        results.api = rest;
      },
      mcp: async () => {
        results.mcp = await mcpJson("spec_supersede", {
          req_id: "BILLING-002",
          statement: successor,
          why: "w",
        });
      },
    });
    expectAllEqual(snapshots);
    expect(results.api).toEqual(results.operation);
    expect(results.mcp).toEqual(results.operation);
    const retag = (results.operation as { retag: unknown[] }).retag;
    expect(retag).toHaveLength(2);

    // The guard refuses the now-superseded predecessor on every surface, before any write.
    const again = await read("BILLING");
    const refused = await supersede(
      { platformDir: platform, id: "BILLING-002", statement: successor },
      fresh(),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("conflict");
    const apiRefused = await apiJson("/api/requirements/BILLING-002/supersede", {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ statement: successor }),
    });
    expect(apiRefused.status).toBe(409);
    expect(await read("BILLING")).toBe(again);
  });

  test("deprecate: operation, CLI, HTTP POST, and MCP write the same envelope and site list", async () => {
    const results: Record<string, unknown> = {};
    const snapshots = await writeThrough(["BILLING"], {
      operation: async () => {
        const r = await deprecate(
          { platformDir: platform, id: "BILLING-002", reason: "gone" },
          fresh(),
        );
        expect(r.ok).toBe(true);
        if (r.ok) results.operation = { id: r.id, file: r.file, reason: r.reason, sites: r.sites };
      },
      cli: () => runCli(deprecateCommand, { id: "BILLING-002", reason: "gone" }),
      api: async () => {
        const res = await apiJson("/api/requirements/BILLING-002/deprecate", {
          method: "POST",
          headers: apiHeaders,
          body: JSON.stringify({ reason: "gone" }),
        });
        expect(res.status).toBe(200);
        const { ok, ...rest } = res.body as Record<string, unknown>;
        expect(ok).toBe(true);
        results.api = rest;
      },
      mcp: async () => {
        results.mcp = await mcpJson("spec_deprecate", { req_id: "BILLING-002", reason: "gone" });
      },
    });
    expectAllEqual(snapshots);
    expect(results.api).toEqual(results.operation);
    expect(results.mcp).toEqual(results.operation);
    expect((results.operation as { sites: unknown[] }).sites).toHaveLength(2);
  });

  test("move: the operation and the CLI write the same two envelopes", async () => {
    const snapshots = await writeThrough(["BILLING", "AUTH"], {
      operation: async () => {
        const r = await move(
          { platformDir: platform, id: "BILLING-003", targetKey: "AUTH" },
          fresh(),
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.newId).toBe("AUTH-001");
          expect(r.sourceSpecVersion).toBe(3);
          expect(r.targetSpecVersion).toBe(1);
        }
      },
      cli: () => runCli(moveCommand, { id: "BILLING-003", newDomain: "auth" }),
    });
    expectAllEqual(snapshots);
  });

  test("term: mint, revise, and confirm write the same envelopes from the operation and the CLI", async () => {
    const minted = await writeThrough(["TERM"], {
      operation: async () => {
        const r = await mintTerm({
          platformDir: platform,
          term: "grace period",
          definition: "days after a failed charge before access ends",
          aliases: ["grace"],
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.id).toBe("TERM-002");
      },
      cli: () =>
        runCli(termCommand, {
          name: "grace period",
          def: "days after a failed charge before access ends",
          aliases: "grace",
        }),
    });
    expectAllEqual(minted);

    const revised = await writeThrough(["TERM"], {
      operation: async () => {
        const r = await reviseTerm({
          platformDir: platform,
          id: "TERM-001",
          definition: "the plan price in force when a renewal is charged",
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.specVersion).toBe(2);
      },
      cli: () =>
        runCli(termCommand, {
          name: "revise",
          platformDir: "TERM-001",
          extra: platform,
          def: "the plan price in force when a renewal is charged",
        }),
    });
    expectAllEqual(revised);

    // The revise above bumped TERM to specVersion 2; the citation in BILLING-003 pins 1.
    const confirmed = await writeThrough(["BILLING"], {
      operation: async () => {
        const r = await confirmTerm({
          platformDir: platform,
          reqId: "BILLING-003",
          termId: "TERM-001",
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.pinned).toBe(2);
      },
      cli: () =>
        runCli(termCommand, {
          name: "confirm",
          platformDir: "BILLING-003",
          extra: "TERM-001",
          extra2: platform,
        }),
    });
    expectAllEqual(confirmed);
  });
});
