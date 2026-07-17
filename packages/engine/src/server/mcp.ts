// packages/engine/src/server/mcp.ts
//
// L4 (lifecycle pass) — the MCP front-end. Exposes the engine's read
// surface as Model Context Protocol tools so any MCP-capable agent harness
// (Claude Code, etc.) can route through Spec Engine natively instead of shelling
// out to the CLI. One engine, three thin front-ends: CLI, webapp, MCP —
// all reading through the same Storage seam.
//
// CORRECTNESS OVER CACHE: an MCP server is long-lived and the agent on the
// other end edits specs and tags BETWEEN calls. Every tool call therefore
// reindexes fresh (rm db + WAL/SHM, rebuild — the same trio discipline as
// `check --ci` and `gate`) before reading. At PoC scale a rebuild is
// milliseconds; a stale answer to an agent is a wrong answer.
//
// Tool results: one text content block whose text is the SAME JSON the
// CLI's --json mode emits for the equivalent command — agents get one
// shape regardless of front-end. Domain errors (malformed id, unknown
// domain) return MCP tool errors (isError: true), never crashes.
//
// D-08: no bun:sqlite import — index access goes through openStorage.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildCoverageReport,
  DEFAULT_QUERY_LIMIT,
  LIMIT_MAX,
  type Storage,
} from "@spec-engine/shared";
import { z } from "zod";
import {
  domainScope,
  listDomainKeys,
  nextRequirementId,
  normalizeDomainKey,
} from "../authoring/domains";
import { collectDiagnostics } from "../check/sqlDiagnostics";
import { defaultIndexPath } from "../constants";
import { runIndex } from "../indexer/pipeline";
import { ID_RE } from "../parser/grammar";
import { coldResetDb, openStorage } from "../storage/sqlite";
import { renderAuthorPrompt } from "./authorPrompt";

/** Tool result helper — one JSON text block (the CLI --json shape). */
function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/** Tool error helper — isError result, never a thrown crash. */
function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

/**
 * Run `fn` against a FRESHLY rebuilt index (cold reset + reindex + close). Tool
 * calls arrive sequentially per MCP session, so the shared db path is not
 * contended within one server.
 */
async function withFreshIndex<T>(platformDir: string, fn: (storage: Storage) => T): Promise<T> {
  const dbPath = defaultIndexPath(platformDir);
  coldResetDb(dbPath);
  const storage = openStorage(dbPath);
  try {
    await runIndex({ platformDir, storage });
    return fn(storage);
  } finally {
    storage.close();
  }
}

/**
 * Build the Spec Engine MCP server for one platform directory. Transport-free —
 * `spec mcp` connects it to stdio; tests connect it to an
 * InMemoryTransport pair.
 */
export function buildMcpServer(platformDir: string): McpServer {
  const server = new McpServer({ name: "spec", version: "0.0.6" });

  server.registerTool(
    "spec_query",
    {
      title: "Full-text requirement retrieval",
      description:
        "Search requirements by full text (SQLite FTS5 MATCH syntax; wrap phrases in double quotes). Returns ranked hits — use this to load the requirements a task touches instead of re-asking the user.",
      inputSchema: {
        text: z.string().min(1).describe("FTS5 query text"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(LIMIT_MAX)
          .optional()
          .describe(`Max hits (default ${DEFAULT_QUERY_LIMIT})`),
      },
    },
    async ({ text, limit }) => {
      try {
        return await withFreshIndex(platformDir, (s) => jsonResult(s.searchFts(text, limit)));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/fts5/i.test(msg) || /syntax/i.test(msg)) {
          return errorResult(`FTS5 query syntax error: ${msg} — wrap phrases in double quotes`);
        }
        throw err;
      }
    },
  );

  server.registerTool(
    "spec_resolve",
    {
      title: "Files → requirements",
      description:
        "The requirements tagged in the given files (platform-relative paths, e.g. api/src/renew.ts). Load these before changing the files.",
      inputSchema: {
        files: z.array(z.string().min(1)).min(1).max(100).describe("Platform-relative file paths"),
      },
    },
    async ({ files }) => withFreshIndex(platformDir, (s) => jsonResult(s.resolveByFiles(files))),
  );

  server.registerTool(
    "spec_req_tags",
    {
      title: "Requirement → tag sites (reverse query)",
      description:
        "Every code/test/doc site tagging the given requirement, across all repos — impact analysis and retag worklists.",
      inputSchema: { req_id: z.string().describe("Requirement id (KEY-NNN)") },
    },
    async ({ req_id }) => {
      if (!ID_RE.test(req_id)) {
        return errorResult(`req_id must be a requirement id (KEY-NNN); got ${req_id}`);
      }
      return withFreshIndex(platformDir, (s) =>
        jsonResult(
          s.listTags({ req_id }).map(({ req_id: rid, repo, file, line, kind, level }) => ({
            req_id: rid,
            repo,
            file,
            line,
            kind,
            level: level ?? null,
          })),
        ),
      );
    },
  );

  server.registerTool(
    "spec_coverage_report",
    {
      title: "Per-domain coverage rollup",
      description:
        "One row per domain over Active requirements: { domain, active, implemented, verified, orphans, unverified }.",
      inputSchema: {},
    },
    async () =>
      withFreshIndex(platformDir, (s) => jsonResult(buildCoverageReport(s.coverageMatrix()))),
  );

  server.registerTool(
    "spec_check",
    {
      title: "Integrity + coverage + drift diagnostics",
      description:
        "Run the full check: structural integrity, coverage, cross-repo drift. Returns the diagnostic rows (severity 'error' rows are what spec check --ci fails CI on).",
      inputSchema: {},
    },
    async () => withFreshIndex(platformDir, (s) => jsonResult(collectDiagnostics(s))),
  );

  server.registerTool(
    "spec_propagation",
    {
      title: "Cross-repo propagation for a superseded requirement",
      description:
        "Per member repo: migrated to the successor (verified or not), still on the predecessor, or unrelated — plus the drift flag.",
      inputSchema: { req_id: z.string().describe("Requirement id (KEY-NNN)") },
    },
    async ({ req_id }) => {
      if (!ID_RE.test(req_id)) {
        return errorResult(`req_id must be a requirement id (KEY-NNN); got ${req_id}`);
      }
      return withFreshIndex(platformDir, (s) => jsonResult(s.propagationFor(req_id)));
    },
  );

  server.registerTool(
    "spec_next_id",
    {
      title: "Next unused requirement id",
      description:
        "Allocate-preview the next unused id in a domain (filesystem-derived; nothing is written). Use before authoring a new requirement.",
      inputSchema: { domain: z.string().min(1).describe("Domain key (e.g. BILLING)") },
    },
    async ({ domain }) => {
      const key = normalizeDomainKey(domain);
      const keys = listDomainKeys(platformDir);
      if (!keys.includes(key)) {
        const available = keys.length > 0 ? keys.join(", ") : "(none)";
        return errorResult(`no domain ${key} — available: ${available}`);
      }
      return jsonResult({ domain: key, next_id: await nextRequirementId(platformDir, key) });
    },
  );

  // The authoring prompt: a STATIC playbook template. registerPrompt
  // auto-advertises the `prompts` capability and derives prompts/list
  // `arguments[]` from the Zod argsSchema — no hand-rolled JSON-RPC. The
  // callback reads the target domain's charter via the pure-FS domainScope
  // (no index build — a template needs no rebuild) and substitutes it into the
  // template. The engine runs NO model here; the client's model consumes the
  // returned text. This is the phase's LLM-free constraint, fence-enforced.
  // @spec AUTHOR-003
  server.registerPrompt(
    "author_requirements",
    {
      title: "Author requirements from a brief",
      description:
        "Turn a vague brief/ticket into well-formed Spec Engine requirements: one requirement per testable promise, placed by domain charter, deduped via spec query, drafted to the GUARD template + cold-read rubric, minted with spec req. The engine returns a static playbook template — your model runs it.",
      argsSchema: {
        brief: z.string().min(1).describe("The vague brief / ticket text to author from"),
        domain: z
          .string()
          .optional()
          .describe("Optional target domain KEY — its charter/scope is injected when given"),
      },
    },
    async ({ brief, domain }) => {
      // Path-containment: normalize THEN validate against the real domain list
      // before reading a charter — never hand an unvalidated (traversal-laden)
      // arg to domainScope, which joins it into a SPEC.json path. Mirrors the
      // spec_next_id tool's normalize-then-membership guard. An unknown domain
      // degrades to a null charter (the "check placement" branch); a `../`-laden
      // arg can never escape platformDir.
      let resolvedDomain: string | undefined;
      let charter: string | null = null;
      if (domain) {
        resolvedDomain = normalizeDomainKey(domain);
        if (listDomainKeys(platformDir).includes(resolvedDomain)) {
          charter = await domainScope(platformDir, resolvedDomain);
        }
      }
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: renderAuthorPrompt({ brief, domain: resolvedDomain, charter }),
            },
          },
        ],
      };
    },
  );

  return server;
}
