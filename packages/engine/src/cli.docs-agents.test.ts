// Hidden smokes (`__` prefix) are exempt: `spec --help` does not advertise them.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RULE_ZERO, STATEMENT_RULE_REASONS, STATEMENT_RULES } from "@spec-engine/shared";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CLI_TS = join(REPO_ROOT, "packages", "engine", "src", "cli.ts");
const BUILDER_DOC = join(REPO_ROOT, "AGENTS.md");
const REFERENCE_PATH = "packages/site/src/content/docs/agent-reference.md";
const AGENT_DOC = join(REPO_ROOT, REFERENCE_PATH);
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

describe("the agent reference", () => {
  test("sanity: the registry parser finds the known public surface", () => {
    const names = publicSubcommands();
    // If the regex rots and returns [], every assertion below passes vacuously.
    for (const core of ["index", "check", "map", "query", "resolve", "gate"]) {
      expect(names).toContain(core);
    }
    expect(names).not.toContain("__schema-smoke");
    expect(names).not.toContain("__schema-mismatch-smoke");
  });

  test("the agent reference exists", () => {
    expect(existsSync(AGENT_DOC)).toBe(true);
  });

  test("every public subcommand is documented in the agent reference", () => {
    const doc = readFileSync(AGENT_DOC, "utf8");
    // A word boundary after the name: a bare substring would pass for a new
    // command named as a prefix of an already-documented one.
    const missing = publicSubcommands().filter(
      (name) => !new RegExp(`spec ${name}(?![\\w-])`).test(doc),
    );
    expect(missing).toEqual([]);
  });

  test("the agent reference covers the agent workflow loop and exit codes", () => {
    const doc = readFileSync(AGENT_DOC, "utf8");
    // Headline strings only; the prose around them is free to change.
    expect(doc).toContain("--json");
    expect(doc).toContain("Exit code");
    expect(doc).toContain("@spec");
  });

  test("the builder AGENTS.md links to the agent reference", () => {
    expect(readFileSync(BUILDER_DOC, "utf8")).toContain(`](${REFERENCE_PATH})`);
  });

  test("README links to the agent reference so agents find their path from the repo root", () => {
    expect(readFileSync(README, "utf8")).toContain(`](${REFERENCE_PATH})`);
  });

  test("states the three-digit requirement-id format rule", () => {
    // @spec CHRT-023 unit
    expect(readFileSync(AGENT_DOC, "utf8")).toMatch(/three-digit zero-padded number/);
  });

  test("states the requirement-authoring standard", () => {
    // @spec CHRT-024 unit
    const doc = readFileSync(AGENT_DOC, "utf8");
    expect(doc).toContain(RULE_ZERO);
    expect(doc).toContain("When an unknown requirement id is passed");
    expect(doc).toContain("make sense on its own");
    expect(doc).toContain("The one-promise lint");
    for (const rule of STATEMENT_RULES) expect(doc).toContain(`| \`${rule}\` |`);
    for (const reason of Object.values(STATEMENT_RULE_REASONS)) expect(doc).toContain(reason);
  });
});

const SKILL_MD = join(REPO_ROOT, ".claude", "skills", "req-author", "SKILL.md");

/** A missing file reads as "", so the assertion fails on content instead of throwing. */
function readOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("the authoring playbook and the req-author skill", () => {
  test("the agent reference carries the brief→mint authoring playbook section", () => {
    // @spec AUTHOR-013 unit
    const doc = readFileSync(AGENT_DOC, "utf8");
    expect(doc).toContain("## Authoring requirements (brief → mint)");
  });

  test("the playbook refers to the authoring standard in the same document", () => {
    // @spec AUTHOR-012 unit
    const doc = readFileSync(AGENT_DOC, "utf8");
    const playbook = doc.slice(doc.indexOf("## Authoring requirements (brief → mint)"));
    expect(doc.indexOf("## Requirement authoring standard")).toBeGreaterThan(-1);
    expect(playbook).toContain("requirement authoring standard above");
    expect(playbook.slice(0, playbook.indexOf("## Command reference"))).not.toContain(
      "| Always true |",
    );
  });

  test("the req-author skill opens with rule 0 and points at the agent reference", () => {
    const skill = readOrEmpty(SKILL_MD);
    expect(skill).toContain(`> ${RULE_ZERO}`);
    expect(skill).toContain("agent-reference.md");
    expect(skill).not.toContain("TAXONOMY");
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
