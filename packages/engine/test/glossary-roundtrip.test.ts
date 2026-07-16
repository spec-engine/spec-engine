// packages/engine/test/glossary-roundtrip.test.ts
//
// TERM-06 (Phase 6, Wave F) — the GLOSSARY round-trip fence. GLOSSARY.md is
// migrated into the TERM store (TERM-001..N), then GENERATED back from the store
// deterministically so the human view can't drift. These are the RED tests for
// that behavior (they fail until commands/glossary.ts + the migrated store land):
//
//   1. migrate/parse — each `- **Name** — def` bullet (multi-line collapsed) parses
//      into a term with its enclosing `## Section`, in document order.
//   2. generate determinism — generation over the same terms is byte-identical
//      across two runs (no Date/random; LLM-free static template).
//   3. round-trip fence — generation over the REAL migrated store equals the
//      committed GLOSSARY.md byte-for-byte (the fence assertion; RED until the
//      migration + regeneration land and are committed).
//   4. gate-safe — the ~30 fresh uncited terms are ORPHAN_TERM WARNINGS, so
//      `spec check --ci` (severity==='error' predicate) stays exit 0 post-migration.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Diagnostic } from "@spec-engine/shared";
import { generateGlossary, parseGlossary } from "../src/commands/glossary";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";

// The real repo root (contains spec-engine/ + the committed GLOSSARY.md).
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const GLOSSARY_MD = join(REPO_ROOT, "GLOSSARY.md");
const TERM_SPEC = join(REPO_ROOT, "spec-engine", "TERM", "SPEC.json");

// A small, self-contained fixture GLOSSARY exercising: an intro (ignored), two
// `## Section` headings, a single-line bullet, a multi-line (hand-wrapped) bullet
// that must collapse to one logical statement, and a second section.
const FIXTURE = `# Glossary

Intro prose that is not a term and must be skipped by the parser — even with an
em-dash in it.

## First section

- **Alpha** — a one-line definition.
- **Beta** — a definition that wraps across
  two source lines and must collapse into
  a single logical statement.

## Second section

- **Gamma** — the third term, under a new section.
`;

/** Read the migrated store the way the generator does: active terms, id-sorted. */
function storeTerms(): { term: string; statement: string; section: string | null }[] {
  const domain = JSON.parse(readFileSync(TERM_SPEC, "utf8")) as {
    requirements?: Array<{
      id?: string;
      status?: string;
      term?: string;
      statement?: string;
      section?: string | null;
    }>;
  };
  const reqs = Array.isArray(domain.requirements) ? domain.requirements : [];
  return reqs
    .filter((r) => String(r.status).toLowerCase() === "active")
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
    .map((r) => ({
      term: String(r.term ?? ""),
      statement: String(r.statement ?? ""),
      section: (r.section ?? null) as string | null,
    }));
}

/** Cold-read the semantic diagnostics for `platformDir` through a fresh index. */
async function diagnose(platformDir: string): Promise<Diagnostic[]> {
  const tmp = mkdtempSync(join(tmpdir(), "spec-glossary-gate-"));
  const s = openStorage(join(tmp, "idx.sqlite"));
  try {
    await runIndex({ platformDir, storage: s });
    return s.listSemanticDiagnostics() as unknown as Diagnostic[];
  } finally {
    s.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("TERM-06 — GLOSSARY round-trip (migrate + generate + fence)", () => {
  // @spec CHCK-006 integration
  test("migrate: parses bullets in document order with section + collapsed statement", () => {
    const terms = parseGlossary(FIXTURE);
    expect(terms.map((t) => t.term)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(terms.map((t) => t.section)).toEqual([
      "First section",
      "First section",
      "Second section",
    ]);
    expect(terms[0].statement).toBe("a one-line definition.");
    // The hand-wrapped Beta bullet collapses to one logical line (single spaces).
    expect(terms[1].statement).toBe(
      "a definition that wraps across two source lines and must collapse into a single logical statement.",
    );
  });

  test("generate: deterministic (byte-identical) across two runs", () => {
    const terms = parseGlossary(FIXTURE);
    const a = generateGlossary(terms);
    const b = generateGlossary(terms);
    expect(a).toBe(b);
    // A generated document ends with exactly one trailing newline and renders a
    // bullet per term under its section heading.
    expect(a.endsWith("\n")).toBe(true);
    expect(a.endsWith("\n\n")).toBe(false);
    expect(a).toContain("## First section");
    expect(a).toContain("- **Alpha** — a one-line definition.");
  });

  test("fence: generation over the REAL store equals the committed GLOSSARY.md", () => {
    const generated = generateGlossary(storeTerms());
    const committed = readFileSync(GLOSSARY_MD, "utf8");
    expect(generated).toBe(committed);
  });

  test("gate-safe: migrated uncited terms are warnings — no error-severity diagnostic", async () => {
    const rows = await diagnose(REPO_ROOT);
    // ORPHAN_TERM is warning; no real requirement cites a term yet, so
    // UNDEFINED_TERM must not fire. The `spec check --ci` exit contract is
    // exactly `rows.some(d => d.severity === "error")`.
    expect(rows.some((d) => d.severity === "error")).toBe(false);
  });
});
