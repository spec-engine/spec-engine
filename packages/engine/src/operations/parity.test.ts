import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Storage } from "@spec-engine/shared";
import { Hono } from "hono";
import { duplicateRefs } from "../check/duplicates";
import { acceptCommand } from "../commands/accept";
import { amendCommand } from "../commands/amend";
import { deprecateCommand } from "../commands/deprecate";
import { moveCommand } from "../commands/move";
import { reqCommand } from "../commands/req";
import { supersedeCommand } from "../commands/supersede";
import { termCommand } from "../commands/term";
import { runIndex } from "../indexer/pipeline";
import { sortRelations } from "../relations/format";
import { mountApi } from "../server/api";
import { buildMcpServer } from "../server/mcp";
import { openStorage } from "../storage/sqlite";
import { commitAndTag } from "../testing/git";
import { entryOf, plantEdit } from "../testing/plant";
import { STATEMENTS, TestPlatform } from "../testing/platform";
import { SPEC_TOKEN, specTag } from "../testing/specTag";
import { coldDuplicateScan, coldFreshTags, withIndex } from "./_index";
import { accept } from "./accept";
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
import { getRecord, listRecords } from "./records";
import { supersede } from "./supersede";
import { confirmTerm, mintTerm, reviseTerm } from "./term";

let tmp: string;
let platform: string;
let fx: TestPlatform;
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

async function mcpRefuses(name: string, args: Record<string, unknown>): Promise<void> {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean };
  expect(res.isError).toBe(true);
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
  fx = TestPlatform.at(platform);
  const billing = await fx.domain("BILLING", { scope: "billing" });
  const first = await billing.req({
    statement: STATEMENTS[0],
    why: "revenue",
  });
  const second = await billing.supersede(first.id, {
    statement: STATEMENTS[5],
    why: "revenue",
  });
  await billing.req({
    statement: STATEMENTS[1],
    why: "revenue",
    cites: [{ term: "TERM-001", pinned: 1 }],
  });
  // A relation and the successor's own creating ticket have no authoring
  // verb, so both are planted onto the successor.
  await plantEdit(platform, "BILLING", (doc) => {
    const successor = entryOf(doc, second.newId);
    successor.relates = ["BILLING-003"];
    successor.issues = [{ role: "created", id: "ENG-1" }];
  });
  await fx.domain("AUTH");
  await fx.terms();
  await fx.term({ term: "renewal price", definition: "the price a plan charges at renewal" });
  await fx.member("api", {
    pin: "spec-engine@2",
    files: {
      "src/renew.ts": `export const renew = 1; ${specTag("BILLING-002")}`,
      "test/renew.test.ts": `export const t = 1; ${specTag("BILLING-002", "unit")}`,
    },
  });
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

  // @spec MAP-003 integration
  // @spec MAP-004 integration
  // @spec SCHM-040 integration
  test("get and list: full records agree across the operation, the API, and MCP", async () => {
    const viaCli = await withIndex({ platformDir: platform, build: "fresh" }, (h) => ({
      one: getRecord(h.storage, "BILLING-002").row,
      unknown: getRecord(h.storage, "BILLING-999").row,
      all: listRecords(h.storage).rows,
      superseded: listRecords(h.storage, { status: "Superseded" }).rows,
    }));
    expect(viaCli.one?.id).toBe("BILLING-002");
    expect(viaCli.one?.implemented_in).toEqual([
      { repo: "api", file: "api/src/renew.ts", line: 1, kind: "implements" },
    ]);
    expect(viaCli.one?.verified_in).toEqual([
      { repo: "api", file: "api/test/renew.test.ts", line: 1, level: "unit" },
    ]);
    expect(viaCli.unknown).toBeNull();
    expect(viaCli.superseded.map((r) => r.id)).toEqual(["BILLING-001"]);
    expect((await apiJson("/api/requirements/BILLING-002")).body).toEqual(viaCli.one);
    expect((await apiJson("/api/requirements/BILLING-999")).status).toBe(404);
    expect((await apiJson("/api/requirements")).body).toEqual(viaCli.all);
    expect((await apiJson("/api/requirements?status=Superseded")).body).toEqual(viaCli.superseded);
    expect(await mcpJson("spec_get", { req_id: "BILLING-002" })).toEqual(viaCli.one);
    expect(await mcpJson("spec_get", { req_id: "BILLING-999" })).toEqual([]);
    expect(await mcpJson("spec_list", {})).toEqual(viaCli.all);
    expect(await mcpJson("spec_list", { status: "superseded" })).toEqual(viaCli.superseded);
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
async function runCli(cmd: unknown, args: Record<string, unknown>): Promise<string> {
  const log = console.log;
  const err = console.error;
  const exit = process.exit;
  const errs: string[] = [];
  const out: string[] = [];
  console.log = (...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  };
  process.exit = ((code: number) => {
    throw new Error(`process.exit(${code}): ${errs.join("\n")}`);
  }) as typeof process.exit;
  try {
    await cliRun(cmd)({ args: { platformDir: platform, ...args }, rawArgs: [] });
    return out.join("\n");
  } finally {
    console.log = log;
    console.error = err;
    process.exit = exit;
  }
}

const specFile = (key: string) => join(platform, "spec-engine", key, "SPEC.json");
const read = (key: string) => Bun.file(specFile(key)).text();

const CODE_FILES = ["src/renew.ts", "test/renew.test.ts"];

async function writeThrough(
  keys: string[],
  surfaces: Record<string, () => Promise<unknown>>,
): Promise<Record<string, string[]>> {
  const restore = fx.snapshotSpecs("api");
  const out: Record<string, string[]> = {};
  for (const [name, run] of Object.entries(surfaces)) {
    restore();
    await run();
    out[name] = [
      ...(await Promise.all(keys.map(read))),
      ...CODE_FILES.map((f) => readFileSync(join(platform, "api", f), "utf8")),
    ];
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

  // @spec SERV-028 unit
  test("mint: operation, CLI, HTTP POST, and MCP write byte-identical entries", async () => {
    const results: Record<string, unknown> = {};
    const snapshots = await writeThrough(["BILLING"], {
      operation: async () => {
        const r = await mint(
          {
            platformDir: platform,
            key: "BILLING",
            statement,
            why: "w",
          },
          coldDuplicateScan(platform),
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
          results.operation = {
            id: r.id,
            file: r.file,
            clauses: r.clauses,
            possible_duplicates: duplicateRefs(r.possibleDuplicates),
          };
        }
      },
      cli: async () => {
        results.cli = JSON.parse(
          await runCli(reqCommand, {
            domainPrefix: "bil",
            text: statement,
            why: "w",
            json: true,
          }),
        );
      },
      api: async () => {
        const posted = await apiJson("/api/requirements", {
          method: "POST",
          headers: apiHeaders,
          body: JSON.stringify({
            key: "BILLING",
            statement,
            why: "w",
          }),
        });
        expect(posted.status).toBe(201);
        results.api = posted.body;
      },
      mcp: async () => {
        results.mcp = await mcpJson("spec_req", {
          domain: "bil",
          text: statement,
          why: "w",
        });
      },
    });
    expectAllEqual(snapshots);
    expect(results.operation).toMatchObject({
      id: "BILLING-004",
      possible_duplicates: [{ id: "BILLING-003", score: 0.86 }],
    });
    expect(results.cli).toEqual(results.operation);
    expect(results.mcp).toEqual(results.operation);
    const op = results.operation as { id: string; possible_duplicates: unknown };
    expect(results.api).toEqual({
      ok: true,
      id: op.id,
      possible_duplicates: op.possible_duplicates,
    });
  });

  // @spec SERV-029 unit
  test("amend: operation, CLI, HTTP PUT, and MCP apply the same field semantics and gates", async () => {
    const results: Record<string, unknown> = {};
    const snapshots = await writeThrough(["BILLING"], {
      operation: async () => {
        const r = await amend(
          {
            platformDir: platform,
            id: "BILLING-003",
            fields: { why: null },
          },
          coldDuplicateScan(platform),
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
          results.operation = {
            id: r.id,
            file: r.file,
            fields_changed: r.fieldsChanged,
            possible_duplicates: duplicateRefs(r.possibleDuplicates),
          };
        }
      },
      cli: async () => {
        results.cli = JSON.parse(
          await runCli(amendCommand, {
            id: "BILLING-003",
            why: "",
            json: true,
          }),
        );
      },
      api: async () => {
        const put = await apiJson("/api/requirements/BILLING-003", {
          method: "PUT",
          headers: apiHeaders,
          body: JSON.stringify({ why: null }),
        });
        expect(put.status).toBe(200);
      },
      mcp: async () => {
        results.mcp = await mcpJson("spec_amend", {
          id: "BILLING-003",
          why: "",
        });
      },
    });
    expectAllEqual(snapshots);
    expect(results.cli).toEqual(results.operation);
    expect(results.mcp).toEqual(results.operation);

    // The release gate refuses on every surface.
    commitAndTag(platform, "v1.0.0");
    const released = await amend(
      {
        platformDir: platform,
        id: "BILLING-002",
        fields: { why: "x" },
      },
      coldDuplicateScan(platform),
    );
    expect(released.ok).toBe(false);
    if (!released.ok) expect(released.reason).toBe("conflict");
    const putReleased = await apiJson("/api/requirements/BILLING-002", {
      method: "PUT",
      headers: apiHeaders,
      body: JSON.stringify({ why: "x" }),
    });
    expect(putReleased.status).toBe(409);
    await mcpRefuses("spec_amend", { id: "BILLING-002", why: "x" });
  });

  // @spec REQ-038 integration
  test("supersede: operation, CLI, HTTP POST, and MCP write the same envelope and retag", async () => {
    const successor = "When a renewal is charged, the billing service shall use the plan price.";
    const results: Record<string, unknown> = {};
    const snapshots = await writeThrough(["BILLING"], {
      operation: async () => {
        const r = await supersede(
          {
            platformDir: platform,
            id: "BILLING-002",
            statement: successor,
            why: "w",
          },
          fresh(),
          coldDuplicateScan(platform, "never"),
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
          results.operation = {
            old_id: r.oldId,
            new_id: r.newId,
            file: r.file,
            spec_version: r.specVersion,
            retagged: r.retagged,
            possible_duplicates: duplicateRefs(r.possibleDuplicates),
          };
        }
      },
      cli: () =>
        runCli(supersedeCommand, {
          id: "BILLING-002",
          text: successor,
          why: "w",
        }),
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
    expect((results.operation as { retagged: unknown[] }).retagged).toHaveLength(2);
    expect(readFileSync(join(platform, "api", "test/renew.test.ts"), "utf8")).toContain(
      `${SPEC_TOKEN} BILLING-004 unit`,
    );

    // The guard refuses the now-superseded predecessor on every surface, before any write.
    const again = await read("BILLING");
    const refused = await supersede(
      { platformDir: platform, id: "BILLING-002", statement: successor },
      fresh(),
      coldDuplicateScan(platform, "never"),
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

  test("deprecate: operation, CLI, HTTP POST, and MCP write the same envelope and remove the same tags", async () => {
    const results: Record<string, unknown> = {};
    const snapshots = await writeThrough(["BILLING"], {
      operation: async () => {
        const r = await deprecate(
          { platformDir: platform, id: "BILLING-002", reason: "gone" },
          fresh(),
        );
        expect(r.ok).toBe(true);
        if (r.ok)
          results.operation = { id: r.id, file: r.file, reason: r.reason, removed: r.removed };
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
    expect((results.operation as { removed: unknown[] }).removed).toHaveLength(2);
    expect(readFileSync(join(platform, "api", "src/renew.ts"), "utf8")).toBe(
      "export const renew = 1;\n",
    );
  });

  // @spec REQ-039 integration
  test("draft mint: the operation and the HTTP POST write byte-identical Draft entries", async () => {
    const restore = fx.snapshotSpecs();
    const direct = await mint(
      {
        platformDir: platform,
        key: "BILLING",
        statement,
        why: "w",
        status: "draft",
      },
      coldDuplicateScan(platform),
    );
    expect(direct.ok).toBe(true);
    const afterDirect = await read("BILLING");

    restore();
    const posted = await apiJson("/api/requirements", {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ key: "BILLING", statement, why: "w", status: "draft" }),
    });
    expect(posted.status).toBe(201);
    expect(await read("BILLING")).toBe(afterDirect);
  });

  // @spec REQ-040 integration
  // @spec REQ-041 integration
  test("accept: operation, CLI, HTTP POST, and MCP promote the same Draft identically", async () => {
    const drafted = await mint(
      {
        platformDir: platform,
        key: "BILLING",
        statement,
        why: "w",
        status: "draft",
      },
      coldDuplicateScan(platform),
    );
    if (!drafted.ok) throw new Error(drafted.detail);
    const id = drafted.id;
    const results: Record<string, unknown> = {};
    const snapshots = await writeThrough(["BILLING"], {
      operation: async () => {
        const r = await accept({ platformDir: platform, id });
        expect(r.ok).toBe(true);
        if (r.ok) results.operation = { id: r.id, file: r.file };
      },
      cli: () => runCli(acceptCommand, { id }),
      api: async () => {
        const res = await apiJson(`/api/requirements/${id}/accept`, {
          method: "POST",
          headers: apiHeaders,
          body: "{}",
        });
        expect(res.status).toBe(200);
        const { ok, ...rest } = res.body as Record<string, unknown>;
        expect(ok).toBe(true);
        results.api = rest;
      },
      mcp: async () => {
        results.mcp = await mcpJson("spec_accept", { req_id: id });
      },
    });
    expectAllEqual(snapshots);
    expect(results.api).toEqual(results.operation);
    expect(results.mcp).toEqual(results.operation);

    const before = await read("BILLING");
    const refused = await apiJson("/api/requirements/BILLING-002/accept", {
      method: "POST",
      headers: apiHeaders,
      body: "{}",
    });
    expect(refused.status).toBe(409);
    expect(await read("BILLING")).toBe(before);
  });

  // @spec SERV-030 unit
  // @spec SERV-031 unit
  test("move: operation, CLI, HTTP POST, and MCP write the same two envelopes and retag", async () => {
    const results: Record<string, unknown> = {};
    const snapshots = await writeThrough(["BILLING", "AUTH"], {
      operation: async () => {
        const r = await move(
          {
            platformDir: platform,
            id: "BILLING-002",
            targetKey: "AUTH",
          },
          fresh(),
          coldDuplicateScan(platform, "never"),
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
          results.operation = {
            old_id: r.oldId,
            new_id: r.newId,
            from_file: r.fromFile,
            to_file: r.toFile,
            source_spec_version: r.sourceSpecVersion,
            target_spec_version: r.targetSpecVersion,
            retagged: r.retagged,
            possible_duplicates: duplicateRefs(r.possibleDuplicates),
          };
        }
      },
      cli: async () => {
        results.cli = JSON.parse(
          await runCli(moveCommand, {
            id: "BILLING-002",
            newDomain: "auth",
            json: true,
          }),
        );
      },
      api: async () => {
        const res = await apiJson("/api/requirements/BILLING-002/move", {
          method: "POST",
          headers: apiHeaders,
          body: JSON.stringify({ newDomain: "auth" }),
        });
        expect(res.status).toBe(201);
        const { ok, ...rest } = res.body as Record<string, unknown>;
        expect(ok).toBe(true);
        results.api = rest;
      },
      mcp: async () => {
        results.mcp = await mcpJson("spec_move", {
          id: "BILLING-002",
          newDomain: "auth",
        });
      },
    });
    expectAllEqual(snapshots);
    expect(results.operation).toMatchObject({
      new_id: "AUTH-001",
      source_spec_version: 3,
      target_spec_version: 1,
    });
    expect((results.operation as { retagged: unknown[] }).retagged).toHaveLength(2);
    expect(results.cli).toEqual(results.operation);
    expect(results.api).toEqual(results.operation);
    expect(results.mcp).toEqual(results.operation);

    // The source is superseded now: every surface refuses before any write.
    const before = await Promise.all(["BILLING", "AUTH"].map(read));
    const apiRefused = await apiJson("/api/requirements/BILLING-002/move", {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ newDomain: "auth" }),
    });
    expect(apiRefused.status).toBe(409);
    await mcpRefuses("spec_move", { id: "BILLING-002", newDomain: "auth" });
    expect(await Promise.all(["BILLING", "AUTH"].map(read))).toEqual(before);

    process.env.SPEC_FLAGS = "";
    const gated = await apiJson("/api/requirements/BILLING-003/move", {
      method: "POST",
      headers: apiHeaders,
      body: JSON.stringify({ newDomain: "auth" }),
    });
    expect(gated.status).toBe(404);
    expect(await Promise.all(["BILLING", "AUTH"].map(read))).toEqual(before);
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

const REFUND = "When a refund is issued, the billing service shall reverse the charge.";
const JSON_HEADERS = { "content-type": "application/json" };

async function send(path: string, method: string, body: unknown, status: number): Promise<void> {
  const res = await apiJson(path, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });
  expect(res.status).toBe(status);
}

function expectOk(r: { ok: boolean }): void {
  expect(r.ok).toBe(true);
}

/** Each write operation that takes `relates`: every surface exposing it, one input each. */
const RELATES_TABLE: Record<string, Record<string, () => Promise<unknown>>> = {
  mint: {
    operation: async () =>
      expectOk(
        await mint(
          {
            platformDir: platform,
            key: "BILLING",
            statement: REFUND,
            why: "w",
            relates: ["BILLING-001, BILLING-003"],
          },
          coldDuplicateScan(platform),
        ),
      ),
    cli: () =>
      runCli(reqCommand, {
        domainPrefix: "BILLING",
        text: REFUND,
        why: "w",
        relates: "BILLING-001,BILLING-003",
      }),
    api: () =>
      send(
        "/api/requirements",
        "POST",
        { key: "BILLING", statement: REFUND, why: "w", relates: ["BILLING-001", " BILLING-003"] },
        201,
      ),
    mcp: async () => {
      await mcpJson("spec_req", {
        domain: "BILLING",
        text: REFUND,
        why: "w",
        relates: ["BILLING-001,BILLING-003"],
      });
    },
  },
  amend: {
    operation: async () =>
      expectOk(
        await amend(
          {
            platformDir: platform,
            id: "BILLING-003",
            fields: { relates: ["BILLING-001,BILLING-002"] },
          },
          coldDuplicateScan(platform),
        ),
      ),
    cli: () => runCli(amendCommand, { id: "BILLING-003", relates: "BILLING-001, BILLING-002" }),
    api: () =>
      send("/api/requirements/BILLING-003", "PUT", { relates: "BILLING-001,BILLING-002" }, 200),
    mcp: async () => {
      await mcpJson("spec_amend", { id: "BILLING-003", relates: ["BILLING-001", "BILLING-002"] });
    },
  },
  supersede: {
    operation: async () =>
      expectOk(
        await supersede(
          { platformDir: platform, id: "BILLING-003", statement: REFUND, relates: ["BILLING-001"] },
          coldFreshTags(platform),
          coldDuplicateScan(platform, "never"),
        ),
      ),
    cli: () =>
      runCli(supersedeCommand, { id: "BILLING-003", text: REFUND, relates: "BILLING-001" }),
    api: () =>
      send(
        "/api/requirements/BILLING-003/supersede",
        "POST",
        { statement: REFUND, relates: ["BILLING-001"] },
        201,
      ),
    mcp: async () => {
      await mcpJson("spec_supersede", {
        req_id: "BILLING-003",
        statement: REFUND,
        relates: ["BILLING-001"],
      });
    },
  },
};

// @spec SCHM-024 integration
// @spec REQ-050 integration
// @spec REQ-051 integration
describe("a relates list reaches every surface of every write operation", () => {
  for (const [operation, surfaces] of Object.entries(RELATES_TABLE)) {
    test(`${operation}: ${Object.keys(surfaces).join(", ")} write the same envelope`, async () => {
      const snapshots = await writeThrough(["BILLING"], surfaces);
      expectAllEqual(snapshots);
      const written = JSON.parse(snapshots.operation?.[0] ?? "{}") as {
        requirements: Array<{ relates: string[] }>;
      };
      const last = written.requirements.at(-1);
      const touched = operation === "amend" ? written.requirements[2] : last;
      expect(touched?.relates[0]).toBe("BILLING-001");
      expect(touched?.relates.length).toBe(operation === "supersede" ? 1 : 2);
    });
  }
});
