// The assets are text imports so the npm bundle and the compiled binary both
// carry them; nothing is read from disk at run time.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import skillSource from "../../../../.claude/skills/req-author/SKILL.md" with { type: "text" };
import referenceSource from "../../../site/src/content/docs/agent-reference.md" with {
  type: "text",
};
import { isExistingDir } from "../constants";

export const AGENT_BLOCK_BEGIN = "<!-- spec-engine:agent-reference:begin -->";
export const AGENT_BLOCK_END = "<!-- spec-engine:agent-reference:end -->";

// The reference binds this repository's requirements with doc tags; an adopter's
// index would read them as dangling tags, so they are stripped from the payload.
export const AGENT_REFERENCE = referenceSource
  .replace(/^---\n[\s\S]*?\n---\n+/, "")
  .replace(/^<!-- @spec [A-Z][A-Z0-9]*-\d+ -->\n\n?/gm, "")
  .replace(/ <!-- @spec [A-Z][A-Z0-9]*-\d+ -->/g, "");

const SKILL_FILES: Record<string, string> = { "req-author/SKILL.md": skillSource };

const PRE_COMMIT = "#!/bin/sh\nspec guard .\nexit $?\n";

function mcpTemplate(platformArg: string): string {
  const body = { mcpServers: { spec: { command: "spec", args: ["mcp", platformArg] } } };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * The `dist/agent/` payload, relative path to content.
 * @spec DIST-020
 */
export function agentPayload(): Record<string, string> {
  const payload: Record<string, string> = {
    "AGENTS.md": AGENT_REFERENCE,
    "mcp.json": mcpTemplate("."),
    "pre-commit": PRE_COMMIT,
  };
  for (const [rel, content] of Object.entries(SKILL_FILES)) payload[`skills/${rel}`] = content;
  return payload;
}

export interface AgentSurfaceInput {
  /** The repository the files go into. */
  dir: string;
  /** The platform the MCP server and the hook point at; null when none was located. */
  platformDir: string | null;
  /** Replace a skill file that differs from the bundled copy. */
  force: boolean;
}

export interface AgentSurfaceResult {
  /** Absolute paths written or changed. */
  written: string[];
  /** Guidance for every file left alone. */
  hints: string[];
}

function shellArg(arg: string): string {
  return /^[\w./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

function writeIfChanged(path: string, content: string, out: AgentSurfaceResult): void {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  out.written.push(path);
}

/**
 * @spec INIT-044
 * @spec INIT-061
 * @spec INIT-049
 */
function writeReferenceBlock(dir: string, out: AgentSurfaceResult): void {
  const path = join(dir, "AGENTS.md");
  const block = `${AGENT_BLOCK_BEGIN}\n${AGENT_REFERENCE.trimEnd()}\n${AGENT_BLOCK_END}`;
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const begin = text.indexOf(AGENT_BLOCK_BEGIN);
  const end = text.indexOf(AGENT_BLOCK_END, begin);
  let next: string;
  if (begin !== -1 && end !== -1) {
    next = text.slice(0, begin) + block + text.slice(end + AGENT_BLOCK_END.length);
  } else if (begin !== -1 || text.includes(AGENT_BLOCK_END)) {
    out.hints.push(
      `${path} holds only one agent-reference marker; restore the pair to let spec init refresh the block`,
    );
    return;
  } else {
    const gap = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    next = `${text}${gap}${block}\n`;
  }
  writeIfChanged(path, next, out);

  const claude = join(dir, "CLAUDE.md");
  if (existsSync(claude) && !readFileSync(claude, "utf8").includes("AGENTS.md")) {
    out.hints.push(
      `${claude} does not reference AGENTS.md; add the line @AGENTS.md so Claude Code loads the spec reference`,
    );
  }
}

/**
 * @spec INIT-045
 * @spec INIT-049
 */
function writeSkill(dir: string, force: boolean, out: AgentSurfaceResult): void {
  for (const [rel, content] of Object.entries(SKILL_FILES)) {
    const path = join(dir, ".claude", "skills", rel);
    if (existsSync(path) && !force && readFileSync(path, "utf8") !== content) {
      out.hints.push(`${path} differs from the bundled skill; re-run with --force to replace it`);
      continue;
    }
    writeIfChanged(path, content, out);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @spec INIT-046
 * @spec INIT-049
 */
function writeMcpEntry(dir: string, platformArg: string, out: AgentSurfaceResult): void {
  const path = join(dir, ".mcp.json");
  const entry = { command: "spec", args: ["mcp", platformArg] };
  const wanted = `add to its mcpServers: "spec": ${JSON.stringify(entry)}`;
  if (!existsSync(path)) {
    writeIfChanged(path, mcpTemplate(platformArg), out);
    return;
  }
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    out.hints.push(`${path} is not valid JSON; left unchanged. ${wanted}`);
    return;
  }
  if (!isRecord(config) || (config.mcpServers !== undefined && !isRecord(config.mcpServers))) {
    out.hints.push(`${path} is not an MCP server config object; left unchanged. ${wanted}`);
    return;
  }
  const servers = config.mcpServers ?? {};
  if (servers.spec !== undefined) {
    if (JSON.stringify(servers.spec) !== JSON.stringify(entry)) {
      out.hints.push(`${path} already has a spec server entry; left unchanged. Expected ${wanted}`);
    }
    return;
  }
  config.mcpServers = { ...servers, spec: entry };
  writeIfChanged(path, `${JSON.stringify(config, null, 2)}\n`, out);
}

/**
 * @spec INIT-047
 * @spec INIT-049
 */
function writeHook(dir: string, platformArg: string, out: AgentSurfaceResult): void {
  const command = `spec guard ${shellArg(platformArg)}`;
  const hooksDir = [join(dir, ".githooks"), join(dir, ".git", "hooks")].find(isExistingDir);
  if (hooksDir === undefined) {
    out.hints.push(`${dir} has no hooks directory; add a pre-commit hook that runs: ${command}`);
    return;
  }
  const path = join(hooksDir, "pre-commit");
  if (existsSync(path)) {
    if (!readFileSync(path, "utf8").includes(command)) {
      out.hints.push(`${path} already exists; left unchanged. Add this line to it: ${command}`);
    }
    return;
  }
  writeFileSync(path, PRE_COMMIT.replace("spec guard .", command), { mode: 0o755 });
  out.written.push(path);
  if (hooksDir.endsWith(".githooks")) {
    out.hints.push(`git runs ${path} only after: git config core.hooksPath .githooks`);
  }
}

export function writeAgentSurface(input: AgentSurfaceInput): AgentSurfaceResult {
  const out: AgentSurfaceResult = { written: [], hints: [] };
  writeReferenceBlock(input.dir, out);
  writeSkill(input.dir, input.force, out);
  if (input.platformDir === null) {
    out.hints.push(
      "no platform was located, so the MCP server and the pre-commit hook were skipped; re-run spec init once the repository belongs to a platform",
    );
    return out;
  }
  const platformArg = relative(input.dir, input.platformDir) || ".";
  writeMcpEntry(input.dir, platformArg, out);
  writeHook(input.dir, platformArg, out);
  return out;
}
