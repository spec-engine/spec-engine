import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import packageJson from "../../package.json" with { type: "json" };
import { type DomainHandle, STATEMENTS, TestPlatform } from "../testing/platform";
import { specTag } from "../testing/specTag";
import { buildMcpServer } from "./mcp";

let fx: TestPlatform;
let platform: string;
let billing: DomainHandle;
let client: Client;
let cleanup: (() => Promise<void>) | null = null;

// A distinctive scope so the charter-injection prompt test can
// assert the exact substring the prompt template injects for domain=BILLING.
const BILLING_SCOPE = "billing lifecycle: renewals, refunds, and invoice pricing";

// Two Active BILLING reqs → nextRequirementId reads SPEC.json and allocates
// BILLING-003.
beforeEach(async () => {
  fx = TestPlatform.temp("spec-mcp-");
  platform = fx.dir;
  billing = await fx.domain("BILLING", { scope: BILLING_SCOPE });
  await billing.req({
    statement: STATEMENTS[0],
    why: "revenue",
  });
  await billing.req({ statement: STATEMENTS[1], why: "trust" });
  await fx.member("api", {
    files: {
      "src/renew.ts": `export const renew = 1; ${specTag("BILLING-001")}`,
      "test/renew.test.ts": `export const t = 1; ${specTag("BILLING-001", "unit")}`,
    },
  });

  const server = buildMcpServer(platform);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanup = async () => {
    await client.close();
    await server.close();
  };
});

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  fx.remove();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  expect(res.isError ?? false).toBe(false);
  expect(res.content[0]?.type).toBe("text");
  return JSON.parse(res.content[0]?.text ?? "null");
}

describe("spec mcp — tool surface", () => {
  test("reports the published package version as its server version", () => {
    expect(client.getServerVersion()?.version).toBe(packageJson.version);
  });

  test("lists the fifteen tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "spec_accept",
      "spec_amend",
      "spec_check",
      "spec_coverage_report",
      "spec_deprecate",
      "spec_get",
      "spec_list",
      "spec_move",
      "spec_next_id",
      "spec_propagation",
      "spec_query",
      "spec_req",
      "spec_req_tags",
      "spec_resolve",
      "spec_supersede",
    ]);
  });

  test("spec_query retrieves by full text", async () => {
    const rows = (await call("spec_query", { text: "renewal" })) as Array<{ req_id: string }>;
    expect(rows.map((r) => r.req_id)).toContain("BILLING-001");
  });

  test("spec_resolve maps files to requirements", async () => {
    const rows = (await call("spec_resolve", { files: ["api/src/renew.ts"] })) as Array<{
      id: string;
    }>;
    expect(rows.map((r) => r.id)).toEqual(["BILLING-001"]);
  });

  test("spec_req_tags is the reverse query", async () => {
    const rows = (await call("spec_req_tags", { req_id: "BILLING-001" })) as Array<{
      file: string;
    }>;
    expect(rows.map((r) => r.file)).toEqual(["api/src/renew.ts", "api/test/renew.test.ts"]);
  });

  test("spec_coverage_report returns the per-domain rollup", async () => {
    const rows = await call("spec_coverage_report");
    expect(rows).toEqual([
      { domain: "BILLING", active: 2, implemented: 1, verified: 1, orphans: 1, unverified: 0 },
    ]);
  });

  test("spec_check surfaces diagnostics (BILLING-002 is an orphan)", async () => {
    const rows = (await call("spec_check")) as Array<{ code: string; req_id: string | null }>;
    expect(rows.some((d) => d.code === "ORPHAN_REQ" && d.req_id === "BILLING-002")).toBe(true);
  });

  test("spec_next_id allocates from the filesystem", async () => {
    expect(await call("spec_next_id", { domain: "BILLING" })).toEqual({
      domain: "BILLING",
      next_id: "BILLING-003",
    });
  });

  test("spec_propagation classifies member repos for a superseded req", async () => {
    const { newId } = await billing.supersede("BILLING-001", {
      statement: STATEMENTS[6],
      why: "w",
    });
    expect(newId).toBe("BILLING-003");
    // propagation takes the SUCCESSOR id: "who migrated to BILLING-003?"
    // api still tags BILLING-001 (the predecessor) → ON_PREDECESSOR.
    const rows = (await call("spec_propagation", { req_id: "BILLING-003" })) as Array<{
      repo: string;
      state: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.repo).toBe("api");
    expect(rows[0]?.state).toBe("ON_PREDECESSOR");
  });

  test("every call reindexes fresh: an edit made after the previous call is visible", async () => {
    await call("spec_query", { text: "renewal" }); // builds the index
    await billing.req({ statement: STATEMENTS[2], why: "w" });
    const rows = (await call("spec_query", { text: "itemize" })) as Array<{ req_id: string }>;
    expect(rows.map((r) => r.req_id)).toContain("BILLING-003");
  });

  test("malformed req_id returns an MCP tool error, not a crash", async () => {
    const res = (await client.callTool({
      name: "spec_req_tags",
      arguments: { req_id: "not-an-id" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("KEY-NNN");
  });

  test("unknown domain in spec_next_id returns a tool error listing candidates", async () => {
    const res = (await client.callTool({
      name: "spec_next_id",
      arguments: { domain: "ZZZ" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("BILLING");
  });
});

// @spec AUTHOR-015 unit
// @spec AUTHOR-016 unit
describe("spec mcp — author_requirements prompt", () => {
  function promptText(res: { messages: Array<{ content: unknown }> }): string {
    return (res.messages[0]?.content as { type: "text"; text: string }).text;
  }

  test("prompts/list advertises author_requirements with brief + domain args", async () => {
    const { prompts } = await client.listPrompts();
    const p = prompts.find((x) => x.name === "author_requirements");
    expect(p).toBeDefined();
    expect(p?.arguments?.map((a) => a.name).sort()).toEqual(["brief", "domain"]);
  });

  test("prompts/get substitutes the brief and takes the no-domain branch", async () => {
    const res = await client.getPrompt({
      name: "author_requirements",
      arguments: { brief: "let users export invoices as PDF" },
    });
    const text = promptText(res);
    expect(text).toContain("let users export invoices as PDF");
    // A stable playbook-body token.
    expect(text).toContain("One requirement per behavior");
    // The no-domain branch marker (no target domain given).
    expect(text).toContain("determine placement from `spec domain list`");
  });

  test("prompts/get injects the domain charter/scope when a domain is given", async () => {
    const res = await client.getPrompt({
      name: "author_requirements",
      arguments: { brief: "add annual billing", domain: "BILLING" },
    });
    const text = promptText(res);
    expect(text).toContain("Target domain: BILLING");
    // The BILLING envelope's scope, injected verbatim from domainScope (FS read).
    expect(text).toContain(BILLING_SCOPE);
  });

  test("prompts/get path-containment: a traversal-laden domain injects no charter", async () => {
    // A `../`-laden domain arg must never escape platformDir into an
    // arbitrary SPEC.json — the callback normalizes THEN membership-checks
    // before any domainScope read, so an out-of-tree domain degrades to a
    // null charter (the "check placement" branch), never a reflected file.
    const res = await client.getPrompt({
      name: "author_requirements",
      arguments: { brief: "add annual billing", domain: "../../../etc/passwd" },
    });
    const text = promptText(res);
    expect(text).not.toContain(BILLING_SCOPE);
    expect(text).not.toContain("Domain charter (scope):");
    expect(text).toContain("no charter/scope recorded");
  });
});
