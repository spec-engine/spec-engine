// Hidden smokes (`__` prefix) are exempt: `spec --help` does not advertise them.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CLI_TS = join(REPO_ROOT, "packages", "engine", "src", "cli.ts");
const AGENT_DOC = join(REPO_ROOT, "AGENTS.md");
const README = join(REPO_ROOT, "README.md");

/**
 * The subcommand names in cli.ts's `subCommands` block. Parsing the source
 * rather than importing the command tree keeps this test free of citty.
 */
function publicSubcommands(): string[] {
  const src = readFileSync(CLI_TS, "utf8");
  const names: string[] = [];
  // Any `name: () =>` key, whatever the quote style or where the import
  // wraps, so a reformat cannot shrink the parsed surface.
  const re = /^\s+(?:"([^"]+)"|([A-Za-z][\w-]*)):\s*\(\)\s*=>/gm;
  for (const m of src.matchAll(re)) {
    const name = m[1] ?? m[2] ?? "";
    if (name && !name.startsWith("__")) names.push(name);
  }
  return names;
}

describe("AGENTS.md", () => {
  test("sanity: the registry parser finds the known public surface", () => {
    const names = publicSubcommands();
    // If the regex rots and returns [], every assertion below passes vacuously.
    for (const core of ["index", "check", "map", "query", "resolve", "gate"]) {
      expect(names).toContain(core);
    }
    expect(names).not.toContain("__schema-smoke");
    expect(names).not.toContain("__schema-mismatch-smoke");
  });

  test("AGENTS.md exists at the repo root", () => {
    expect(existsSync(AGENT_DOC)).toBe(true);
  });

  test("every public subcommand is documented in AGENTS.md", () => {
    const doc = readFileSync(AGENT_DOC, "utf8");
    // A word boundary after the name: a bare substring would pass for a new
    // command named as a prefix of an already-documented one.
    const missing = publicSubcommands().filter(
      (name) => !new RegExp(`spec ${name}(?![\\w-])`).test(doc),
    );
    expect(missing).toEqual([]);
  });

  test("AGENTS.md covers the agent workflow loop and exit codes", () => {
    const doc = readFileSync(AGENT_DOC, "utf8");
    // Headline strings only; the prose around them is free to change.
    expect(doc).toContain("--json");
    expect(doc).toContain("Exit code");
    expect(doc).toContain("@spec");
  });

  test("README links to AGENTS.md so agents find their path from the repo root", () => {
    const readme = readFileSync(README, "utf8");
    // The explicit markdown link form — a bare "AGENTS.md" substring would
    // be vacuously satisfied by prose mentioning the filename.
    expect(readme).toContain("[AGENTS.md](AGENTS.md)");
  });
});

const SKILL_MD = join(REPO_ROOT, ".claude", "skills", "req-author", "SKILL.md");

/** A missing file reads as "", so the assertion fails on content instead of throwing. */
function readOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("AGENTS.md authoring playbook and the req-author skill", () => {
  test("AGENTS.md carries the brief→mint authoring playbook section", () => {
    // @spec AUTHOR-010 unit
    const doc = readFileSync(AGENT_DOC, "utf8");
    expect(doc).toContain("## Authoring requirements (brief → mint)");
  });

  test("the playbook points at the TAXONOMY authoring standard without ghost section numbers", () => {
    // @spec AUTHOR-005 unit
    const agents = readFileSync(AGENT_DOC, "utf8");
    expect(agents).toContain("Requirement authoring standard");
    expect(agents).not.toContain("4.10");
  });

  test("the req-author SKILL.md exists with frontmatter + approval gate + rubric cross-ref + real-CLI dogfood", () => {
    // @spec AUTHOR-006 unit
    // @spec AUTHOR-007 unit
    const skill = readOrEmpty(SKILL_MD);
    expect(skill).toContain("name:");
    expect(skill).toContain("description:");
    expect(skill).toMatch(/approval|before writing/i);
    expect(skill).toContain("shall");
    expect(skill).toMatch(/source quote|quotes its source/i);
    expect(skill).toContain("spec req");
  });
});
