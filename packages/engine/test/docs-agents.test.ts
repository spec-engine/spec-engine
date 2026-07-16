// packages/engine/test/docs-agents.test.ts
//
// RED-19: agent-facing documentation must exist alongside the human README
// and stay COMPLETE as the CLI grows. The completeness contract is
// mechanical, not aspirational: this test walks the public subcommand
// registry in packages/engine/src/cli.ts and fails if any public
// subcommand is missing from the root AGENTS.md — so adding a command without
// documenting its agent-facing contract breaks CI, the same way the
// coverage VIEW cannot drift from tags.
//
// Hidden CI smokes (names prefixed `__`) are exempt: they are not part of
// the public surface and `spec --help` does not advertise them to agents.
//
// Doc-only changes are normally TDD-exempt (AGENTS.md), but RED-19's
// acceptance criterion 4 makes completeness itself a tested behavior, so
// the failing test came first.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CLI_TS = join(REPO_ROOT, "packages", "engine", "src", "cli.ts");
const AGENT_DOC = join(REPO_ROOT, "AGENTS.md");
const README = join(REPO_ROOT, "README.md");

/**
 * Extract the subcommand names registered in cli.ts's `subCommands` block.
 * Matches both bare identifiers (`index: () => import(...)`) and quoted
 * names (`"__schema-smoke": () => import(...)`). Parsing the source (not
 * importing the command tree) keeps this test free of citty/runtime
 * coupling — the registry literal IS the public contract.
 */
function publicSubcommands(): string[] {
  const src = readFileSync(CLI_TS, "utf8");
  const names: string[] = [];
  // Self-review hardening: match any `name: () =>` lazy-subcommand key
  // WITHOUT requiring the quote style or the `import("./commands/` call on
  // the same line — a formatter that switches quotes or wraps the import
  // would otherwise silently shrink the parsed surface and let new commands
  // ship undocumented (the exact failure mode this test exists to prevent).
  // The sanity test below guards this regex against rot.
  const re = /^\s+(?:"([^"]+)"|([A-Za-z][\w-]*)):\s*\(\)\s*=>/gm;
  for (const m of src.matchAll(re)) {
    const name = m[1] ?? m[2] ?? "";
    if (name && !name.startsWith("__")) names.push(name);
  }
  return names;
}

describe("AGENTS.md (RED-19 agent-facing documentation)", () => {
  test("sanity: the registry parser finds the known public surface", () => {
    const names = publicSubcommands();
    // Guard the parser itself: if the regex rots and returns [], every
    // downstream assertion would vacuously pass. The known-core commands
    // must all be present and the hidden smokes must not.
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
    // Self-review hardening: require a word boundary after the name, not a
    // bare substring — `includes("spec ser")` would be vacuously satisfied
    // by the existing "spec serve" text if a future command were named as
    // a prefix of an already-documented one.
    const missing = publicSubcommands().filter(
      (name) => !new RegExp(`spec ${name}(?![\\w-])`).test(doc),
    );
    expect(missing).toEqual([]);
  });

  test("AGENTS.md covers the agent workflow loop and exit codes", () => {
    const doc = readFileSync(AGENT_DOC, "utf8");
    // The route → tag → check loop is the doc's reason to exist (criterion
    // 2); exit codes are the contract agents branch on. Headline strings,
    // not prose style, are what's locked.
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

// ── Wave 0 RED bar for Phase 5 (authoring pipeline) ─────────────────────────
// These are the VERIFYING tests for two doc-only requirements minted in later
// waves (their verifying `@spec` tags — AUTHOR-001 unit / AUTHOR-002 unit — are
// added atomically at mint in Wave 1; a tag here now, before the mint, would be
// a DANGLING_TAG that fails `spec check . --ci`, so NONE is written yet). They are
// authored RED-first: the AGENTS.md playbook section and the req-author SKILL.md
// do not exist yet, so each assertion below is a clean CONTENT failure (a missing
// SKILL.md degrades to an empty string, never an unhandled read throw — the
// taxonomy.test.ts CHRT-001/002 precedent). Wave 1 turns them GREEN.

const SKILL_MD = join(REPO_ROOT, ".claude", "skills", "req-author", "SKILL.md");

/** Read a doc guarding a missing file so the RED failure lands as a
 * content-assertion failure, not an unhandled read throw. */
function readOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("AGENTS.md authoring playbook (AUTHOR-001) + req-author skill (AUTHOR-002)", () => {
  test("AGENTS.md carries the brief→mint authoring playbook section", () => {
    // @spec AUTHOR-001 unit
    const doc = readFileSync(AGENT_DOC, "utf8");
    // The playbook section header — the mint front-half that feeds the existing
    // route → tag → check loop.
    expect(doc).toContain("## Authoring requirements (brief → mint)");
  });

  test("the playbook cross-references TAXONOMY.md §4.10 (does not fork the rubric)", () => {
    const doc = readFileSync(AGENT_DOC, "utf8");
    // Body-scoped: the cross-reference must live INSIDE the new playbook
    // section, not incidentally elsewhere in AGENTS.md — otherwise a stray
    // `4.10`/`TAXONOMY.md` token far from the section would vacuously satisfy
    // "cross-reference not fork". Slice from the header forward and assert the
    // rubric-pointer tokens appear in that tail.
    const idx = doc.indexOf("## Authoring requirements (brief → mint)");
    const body = idx === -1 ? "" : doc.slice(idx);
    expect(body).toContain("spec-engine/TAXONOMY.md");
    expect(body).toContain("4.10");
  });

  test("the req-author SKILL.md exists with frontmatter + approval gate + rubric cross-ref + real-CLI dogfood", () => {
    // @spec AUTHOR-002 unit
    const skill = readOrEmpty(SKILL_MD);
    // YAML frontmatter keys (the Claude Code skill convention).
    expect(skill).toContain("name:");
    expect(skill).toContain("description:");
    // Approval-before-write gate — the skill never mints without a human OK.
    expect(skill).toMatch(/approval|before writing/i);
    // Cross-references the §4.10 rubric rather than re-authoring it.
    expect(skill).toMatch(/4\.10|cold.read/i);
    // Dogfoods the REAL CLI — the skill drives `spec req`, never a reimpl.
    expect(skill).toContain("spec req");
  });
});
