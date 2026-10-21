import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Diagnostic } from "@spec-engine/shared";
import { glossaryCommand } from "../commands/glossary";
import { runIndex } from "../indexer/pipeline";
import { openStorage } from "../storage/sqlite";
import { TestPlatform } from "../testing/platform";
import { generateGlossary, parseGlossary } from "./glossary";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const GLOSSARY_MD = join(REPO_ROOT, "GLOSSARY.md");
const TERM_SPEC = join(REPO_ROOT, "spec-engine", "TERM", "SPEC.json");

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

describe("GLOSSARY round-trip (migrate + generate + fence)", () => {
  // @spec CHCK-021 integration
  test("migrate: parses bullets in document order with section + collapsed statement", () => {
    const terms = parseGlossary(FIXTURE);
    expect(terms.map((t) => t.term)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(terms.map((t) => t.section)).toEqual([
      "First section",
      "First section",
      "Second section",
    ]);
    expect(terms[0]?.statement).toBe("a one-line definition.");
    expect(terms[1]?.statement).toBe(
      "a definition that wraps across two source lines and must collapse into a single logical statement.",
    );
  });

  // @spec CHCK-020 integration
  test("generate: deterministic (byte-identical) across two runs", () => {
    const terms = parseGlossary(FIXTURE);
    const a = generateGlossary(terms);
    const b = generateGlossary(terms);
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
    expect(a.endsWith("\n\n")).toBe(false);
    expect(a).toContain("## First section");
    expect(a).toContain("- **Alpha** — a one-line definition.");
  });

  // @spec CHCK-020 integration
  test("fence: generation over the REAL store equals the committed GLOSSARY.md", () => {
    const generated = generateGlossary(storeTerms());
    const committed = readFileSync(GLOSSARY_MD, "utf8");
    expect(generated).toBe(committed);
  });

  test("gate-safe: migrated uncited terms are warnings — no error-severity diagnostic", async () => {
    const rows = await diagnose(REPO_ROOT);
    // The `spec check --ci` exit contract is exactly this predicate.
    expect(rows.some((d) => d.severity === "error")).toBe(false);
  });

  // @spec CHCK-022 integration
  test("--check: exit 1 on byte drift, no exit when committed equals generated", async () => {
    const fx = TestPlatform.temp("spec-glossary-check-");
    const plat = fx.dir;
    const originalExit = process.exit;
    const originalErr = console.error;
    const originalLog = console.log;
    class ExitError extends Error {
      constructor(public code: number) {
        super(`process.exit(${code})`);
      }
    }
    try {
      const term = { term: "Alpha", statement: "a one-line definition.", section: "First section" };
      await fx.terms();
      await fx.term({ term: term.term, definition: term.statement, section: term.section });
      (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
        throw new ExitError(code ?? 0);
      };
      console.error = () => {};
      console.log = () => {};
      const run = (
        glossaryCommand as unknown as {
          run: (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
        }
      ).run;
      writeFileSync(join(plat, "GLOSSARY.md"), generateGlossary([term]));
      await run({ args: { platformDir: plat, check: true }, rawArgs: [] });
      writeFileSync(join(plat, "GLOSSARY.md"), "# Glossary\n\ndrifted\n");
      let code: number | null = null;
      try {
        await run({ args: { platformDir: plat, check: true }, rawArgs: [] });
      } catch (e) {
        if (e instanceof ExitError) code = e.code;
        else throw e;
      }
      expect(code).toBe(1);
    } finally {
      process.exit = originalExit;
      console.error = originalErr;
      console.log = originalLog;
      fx.remove();
    }
  });
});
