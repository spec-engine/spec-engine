import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_BLOCK_BEGIN,
  AGENT_BLOCK_END,
  AGENT_REFERENCE,
  agentPayload,
  writeAgentSurface,
} from "./agentSurface";

let platform: string;
let repo: string;

beforeEach(() => {
  platform = mkdtempSync(join(tmpdir(), "spec-agent-surface-"));
  repo = join(platform, "api");
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
});

afterEach(() => rmSync(platform, { recursive: true, force: true }));

const read = (rel: string): string => readFileSync(join(repo, rel), "utf8");
const run = (force = false) => writeAgentSurface({ dir: repo, platformDir: platform, force });

function snapshot(): Record<string, string> {
  const files = [
    "AGENTS.md",
    ".claude/skills/req-author/SKILL.md",
    ".mcp.json",
    ".git/hooks/pre-commit",
  ];
  return Object.fromEntries(files.map((f) => [f, read(f)]));
}

describe("writeAgentSurface", () => {
  test("the installed reference carries no doc tag of this repository's requirements", () => {
    // @spec INIT-044 unit
    run();
    expect(read("AGENTS.md")).not.toMatch(/<!-- @spec [A-Z][A-Z0-9]*-\d+ -->/);
  });

  test("a bare repository gets the reference block, the skill, the MCP entry, and the hook", () => {
    // @spec INIT-044 unit
    // @spec INIT-045 unit
    // @spec INIT-046 unit
    // @spec INIT-047 unit
    const result = run();
    expect(result.written).toHaveLength(4);
    expect(read("AGENTS.md")).toBe(
      `${AGENT_BLOCK_BEGIN}\n${AGENT_REFERENCE.trimEnd()}\n${AGENT_BLOCK_END}\n`,
    );
    expect(read(".claude/skills/req-author/SKILL.md")).toBe(
      agentPayload()["skills/req-author/SKILL.md"] ?? "",
    );
    expect(JSON.parse(read(".mcp.json"))).toEqual({
      mcpServers: { spec: { command: "spec", args: ["mcp", ".."] } },
    });
    expect(read(".git/hooks/pre-commit")).toBe("#!/bin/sh\nspec guard ..\nexit $?\n");
    expect(statSync(join(repo, ".git/hooks/pre-commit")).mode & 0o111).not.toBe(0);
  });

  test("a second run writes nothing and leaves every file byte-identical", () => {
    // @spec INIT-061 unit
    run();
    const before = snapshot();
    expect(run().written).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  test("an existing block is replaced in place and the text around it is kept", () => {
    // @spec INIT-061 unit
    // @spec INIT-049 unit
    writeFileSync(
      join(repo, "AGENTS.md"),
      `# Team rules\n\n${AGENT_BLOCK_BEGIN}\nstale\n${AGENT_BLOCK_END}\n\nTrailing notes.\n`,
    );
    run();
    expect(read("AGENTS.md")).toBe(
      `# Team rules\n\n${AGENT_BLOCK_BEGIN}\n${AGENT_REFERENCE.trimEnd()}\n${AGENT_BLOCK_END}\n\nTrailing notes.\n`,
    );
  });

  test("an AGENTS.md without markers gets the block appended after its own text", () => {
    // @spec INIT-049 unit
    writeFileSync(join(repo, "AGENTS.md"), "# Team rules");
    run();
    expect(read("AGENTS.md").startsWith(`# Team rules\n\n${AGENT_BLOCK_BEGIN}\n`)).toBe(true);
  });

  test("a CLAUDE.md that skips AGENTS.md is left alone with a hint", () => {
    // @spec INIT-049 unit
    writeFileSync(join(repo, "CLAUDE.md"), "# Claude\n");
    const result = run();
    expect(read("CLAUDE.md")).toBe("# Claude\n");
    expect(result.hints.some((h) => h.includes("@AGENTS.md"))).toBe(true);
  });

  test("foreign MCP servers survive and an existing spec entry is never replaced", () => {
    // @spec INIT-046 unit
    // @spec INIT-049 unit
    writeFileSync(
      join(repo, ".mcp.json"),
      JSON.stringify({ other: 1, mcpServers: { db: { command: "db" } } }),
    );
    run();
    expect(JSON.parse(read(".mcp.json"))).toEqual({
      other: 1,
      mcpServers: { db: { command: "db" }, spec: { command: "spec", args: ["mcp", ".."] } },
    });
    const custom = JSON.stringify({ mcpServers: { spec: { command: "my-spec" } } });
    writeFileSync(join(repo, ".mcp.json"), custom);
    const result = run();
    expect(read(".mcp.json")).toBe(custom);
    expect(result.hints.some((h) => h.includes("already has a spec server entry"))).toBe(true);
  });

  test("an MCP config that is not JSON is left unchanged", () => {
    // @spec INIT-049 unit
    writeFileSync(join(repo, ".mcp.json"), "{ nope");
    run();
    expect(read(".mcp.json")).toBe("{ nope");
  });

  test("an existing pre-commit hook is never overwritten", () => {
    // @spec INIT-047 unit
    // @spec INIT-049 unit
    writeFileSync(join(repo, ".git/hooks/pre-commit"), "#!/bin/sh\nlint\n");
    const result = run();
    expect(read(".git/hooks/pre-commit")).toBe("#!/bin/sh\nlint\n");
    expect(result.hints.some((h) => h.includes("spec guard .."))).toBe(true);
  });

  test("a shared .githooks directory takes the hook ahead of .git/hooks", () => {
    // @spec INIT-047 unit
    mkdirSync(join(repo, ".githooks"));
    const result = run();
    expect(existsSync(join(repo, ".githooks/pre-commit"))).toBe(true);
    expect(existsSync(join(repo, ".git/hooks/pre-commit"))).toBe(false);
    expect(result.hints.some((h) => h.includes("core.hooksPath .githooks"))).toBe(true);
  });

  test("a locally edited skill is replaced only under force", () => {
    // @spec INIT-045 unit
    run();
    writeFileSync(join(repo, ".claude/skills/req-author/SKILL.md"), "local edit\n");
    run();
    expect(read(".claude/skills/req-author/SKILL.md")).toBe("local edit\n");
    run(true);
    expect(read(".claude/skills/req-author/SKILL.md")).not.toBe("local edit\n");
  });

  test("with no platform the MCP entry and the hook are skipped", () => {
    // @spec INIT-046 unit
    // @spec INIT-047 unit
    const result = writeAgentSurface({ dir: repo, platformDir: null, force: false });
    expect(result.written).toHaveLength(2);
    expect(existsSync(join(repo, ".mcp.json"))).toBe(false);
    expect(existsSync(join(repo, ".git/hooks/pre-commit"))).toBe(false);
  });
});
