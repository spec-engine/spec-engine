// packages/engine/test/cli-mcp.test.ts
//
// L4 (lifecycle pass) — `spec mcp` end-to-end over REAL stdio: spawn the
// CLI, speak newline-delimited JSON-RPC (initialize → initialized →
// tools/list), and assert the tool surface comes back. This is the seam
// the in-process InMemoryTransport tests (server-mcp.test.ts) cannot
// cover — argv parsing, the stdout-is-protocol discipline, and the stdio
// transport wiring.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "..", "src", "cli.ts");

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-mcp-cli-"));
  mkdirSync(join(tmp, "spec-engine", "ORD"), { recursive: true });
  writeFileSync(
    join(tmp, "spec-engine", "ORD", "SPEC.md"),
    "---\nkey: ORD\nspec_version: 1\n---\n\n### ORD-001 — Active\n**Requirement:** r\n" +
      "**Why it matters:** w\n**Binds:** \n**Lives in:** \n",
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("spec mcp (stdio end-to-end)", () => {
  test("initialize + tools/list over stdio returns the seven tools; stdout carries only JSON-RPC", async () => {
    const proc = Bun.spawn(["bun", CLI, "mcp", tmp], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const send = (msg: Record<string, unknown>) => {
      proc.stdin.write(`${JSON.stringify(msg)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    proc.stdin.flush();

    // Read stdout lines until the id:2 response (bounded by the test timeout).
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    type ToolsResponse = { id?: number; result?: { tools?: Array<{ name: string }> } };
    let toolsResponse: ToolsResponse | null = null;
    const lines: string[] = [];
    while (toolsResponse === null) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          lines.push(line);
          const msg = JSON.parse(line) as ToolsResponse;
          if (msg.id === 2) toolsResponse = msg;
        }
        nl = buffer.indexOf("\n");
      }
    }
    proc.kill();
    await proc.exited;

    // Every stdout line parsed as JSON (the protocol-channel discipline) —
    // JSON.parse above would have thrown otherwise.
    expect(lines.length).toBeGreaterThan(0);
    const tools = (toolsResponse as ToolsResponse | null)?.result?.tools ?? [];
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "spec_check",
      "spec_coverage_report",
      "spec_next_id",
      "spec_propagation",
      "spec_query",
      "spec_req_tags",
      "spec_resolve",
    ]);
  }, 20000);

  test("non-platform dir exits 2 with guidance on stderr", async () => {
    const empty = join(tmp, "not-a-platform");
    mkdirSync(empty, { recursive: true });
    const proc = Bun.spawn(["bun", CLI, "mcp", empty], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).toBe(2);
    expect(stderr).toContain("spec-engine");
  }, 20000);
});
