// packages/engine/src/commands/glossary.ts
//
// Wave F (06-06) — `spec glossary`: the GLOSSARY.md round-trip (TERM-06). The
// repo's own GLOSSARY.md is migrated ONCE into the TERM store (TERM-001..N), and
// thereafter GENERATED back from the store so the human view can't silently
// drift from the canonical terms — a CI fence (arch-fences.sh + a bun test)
// asserts committed == generated forever.
//
//   spec glossary [platformDir]            — GENERATE GLOSSARY.md from the store
//   spec glossary --migrate [platformDir]  — one-time: parse GLOSSARY.md → TERM store
//   spec glossary --check [platformDir]    — regenerate into a buffer, diff vs the
//                                            committed GLOSSARY.md, exit 1 on drift
//
// DETERMINISM (the hard requirement): generation is an LLM-free static-template
// projection of the store — a fixed `# Glossary` header + a fixed intro, terms
// walked in id order, each `## {section}` heading emitted once when it changes,
// then a `- **{term}** — {statement}` bullet per term, single trailing newline.
// NO Date/random ever touches the output, so two runs are byte-identical.
//
// SEAM DISCIPLINE: the migration authors through the ONE `validateAndWrite`
// (VAL-01) seam — never a bespoke Bun.write of the domain file. Generation writes
// the DERIVED human view (GLOSSARY.md), which is not a domain spec file, so it
// uses Bun.write directly (outside the VAL-01 seam by design). Generation is a
// CLI authoring/build action, NOT part of `spec index` (index stays
// read-only-to-source).
//
// LAYOUT: multi-line hand-wrapped source definitions collapse to a single logical
// statement; the regenerated file (one line per bullet) is the new canonical form.
// "The human view can't drift" is the hard requirement, not preserving the old
// hand-wrapping.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateAndWrite } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { localToday } from "../authoring/edit";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { handleNotAPlatform } from "./_shared";

const TERM_KEY = "TERM";

// The fixed intro chrome — glossary boilerplate, verbatim, carried as a static
// constant (it is not a term, so it lives in the template, never in the store).
const GLOSSARY_INTRO = `Canonical names for Spec Engine concepts. When prose, code comments, diagnostics, or
docs need one of these ideas, use the term below — not a synonym. Terms are ordered
by the data model, outside-in.`;

/** A parsed / stored glossary term: the headword, its definition, its section. */
export interface GlossaryTerm {
  term: string;
  statement: string;
  section: string | null;
}

/**
 * Parse a GLOSSARY.md into terms in DOCUMENT ORDER. Walks lines: `## X` sets the
 * current section; `- **Name** — def` opens a bullet; indented continuation lines
 * collapse into the bullet's single logical statement; a blank line or the next
 * bullet/heading flushes it. The intro (before the first `## `) has no bullets and
 * is skipped. A bullet whose headword carries a parenthetical before the ` — `
 * (e.g. `**Charter** (a domain's *scope*) — …`) keeps that parenthetical in the
 * statement (nothing is lost); only a leading ` — ` separator is stripped.
 */
export function parseGlossary(md: string): GlossaryTerm[] {
  const terms: GlossaryTerm[] = [];
  let section: string | null = null;
  let buf: string | null = null;

  const flush = () => {
    if (buf === null) return;
    const m = buf.match(/^\*\*(.+?)\*\*/);
    if (m) {
      const remainder = buf.slice(m[0].length);
      const statement = remainder.replace(/^ — /, "").trim();
      terms.push({ term: m[1], statement, section });
    }
    buf = null;
  };

  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      section = line.slice(3).trim();
    } else if (line.startsWith("- ")) {
      flush();
      buf = line.slice(2);
    } else if (buf !== null) {
      if (line.trim() === "") flush();
      else buf += ` ${line.trim()}`;
    }
  }
  flush();
  return terms;
}

/**
 * Generate GLOSSARY.md from terms deterministically: the fixed header + intro,
 * each `## {section}` heading once when it changes, a `- **{term}** — {statement}`
 * bullet per term, single trailing newline. LLM-free, no Date/random.
 * @spec CHCK-006
 */
export function generateGlossary(terms: GlossaryTerm[]): string {
  const parts: string[] = ["# Glossary", "", GLOSSARY_INTRO];
  let section: string | null | undefined; // undefined sentinel ≠ any real section
  for (const t of terms) {
    if (t.section !== section) {
      section = t.section;
      if (section !== null && section !== undefined) {
        parts.push("", `## ${section}`, "");
      }
    }
    parts.push(`- **${t.term}** — ${t.statement}`);
  }
  return `${parts.join("\n")}\n`;
}

/** Resolve the optional platformDir positional + run the platform guard. */
function resolvePlatform(platformDirRaw: string | undefined): string {
  const platformDir = resolve(platformDirRaw ?? process.cwd());
  try {
    assertSpecPlatform(platformDir);
  } catch (e) {
    handleNotAPlatform(e);
  }
  return platformDir;
}

/** Read the TERM store the way generation consumes it: active terms, id-sorted. */
function readStoreTerms(platformDir: string): GlossaryTerm[] {
  const specPath = join(platformDir, "spec-engine", TERM_KEY, "SPEC.json");
  if (!existsSync(specPath)) return [];
  const domain = JSON.parse(readFileSync(specPath, "utf8")) as {
    requirements?: Array<Record<string, unknown>>;
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

/** The GLOSSARY.md path for a platform (repo-root sibling of spec-engine/). */
function glossaryPath(platformDir: string): string {
  return join(platformDir, "GLOSSARY.md");
}

/**
 * One-time migration: parse the committed GLOSSARY.md into TERM-001..N and write
 * them through the VAL-01 seam. Idempotent — skips when the TERM domain already
 * holds entries (so re-running never doubles the store).
 */
async function migrateGlossary(platformDir: string, json: boolean): Promise<void> {
  const relFile = `spec-engine/${TERM_KEY}/SPEC.json`;
  const specPath = join(platformDir, "spec-engine", TERM_KEY, "SPEC.json");
  if (!existsSync(specPath)) {
    console.error(`spec glossary: no TERM domain (expected ${relFile} under ${platformDir})`);
    process.exit(EXIT.USAGE);
  }
  const domain = JSON.parse(readFileSync(specPath, "utf8")) as {
    requirements?: unknown[];
    [k: string]: unknown;
  };
  const existing = Array.isArray(domain.requirements) ? domain.requirements : [];
  if (existing.length > 0) {
    console.error(
      `spec glossary: TERM domain already holds ${existing.length} entries — migration skipped`,
    );
    if (json) console.log(JSON.stringify({ migrated: 0, skipped: true }));
    else console.log("migration skipped (TERM domain not empty)");
    return;
  }
  const gPath = glossaryPath(platformDir);
  if (!existsSync(gPath)) {
    console.error(`spec glossary: no GLOSSARY.md to migrate (expected ${gPath})`);
    process.exit(EXIT.USAGE);
  }
  const parsed = parseGlossary(readFileSync(gPath, "utf8"));
  domain.requirements = parsed.map((t, i) => ({
    id: `${TERM_KEY}-${String(i + 1).padStart(3, "0")}`,
    status: "active",
    statement: t.statement,
    term: t.term,
    why: null,
    supersedes: null,
    supersededBy: null,
    relates: [],
    livesIn: [],
    issues: [],
    aliases: [],
    cites: [],
    changedAtVersion: 1,
    section: t.section,
  }));
  domain.updated = localToday();

  const res = await validateAndWrite(specPath, domain, relFile);
  if (!res.ok) {
    for (const diag of res.diagnostics) console.error(`spec glossary: ${diag.detail}`);
    process.exit(EXIT.USAGE);
  }
  const count = parsed.length;
  if (json) console.log(JSON.stringify({ migrated: count, file: relFile }));
  else console.log(`migrated ${count} terms into ${relFile}`);
}

/** Generate GLOSSARY.md from the store and overwrite the committed file. */
async function writeGlossary(platformDir: string, json: boolean): Promise<void> {
  const terms = readStoreTerms(platformDir);
  await Bun.write(glossaryPath(platformDir), generateGlossary(terms));
  if (json) console.log(JSON.stringify({ generated: terms.length, file: "GLOSSARY.md" }));
  else console.log(`generated GLOSSARY.md from ${terms.length} terms`);
}

/**
 * The drift fence: regenerate into a buffer and compare byte-for-byte with the
 * committed GLOSSARY.md. Exit 1 (data-level failure) on any drift, 0 clean. This
 * is what fence_glossary_roundtrip (arch-fences.sh) shells out to.
 * @spec CHCK-006
 */
function checkGlossary(platformDir: string, json: boolean): void {
  const generated = generateGlossary(readStoreTerms(platformDir));
  const gPath = glossaryPath(platformDir);
  const committed = existsSync(gPath) ? readFileSync(gPath, "utf8") : "";
  if (generated === committed) {
    if (json) console.log(JSON.stringify({ ok: true }));
    else console.error("glossary round-trip: OK (committed GLOSSARY.md == generated)");
    return;
  }
  console.error("glossary drift: committed GLOSSARY.md != generated from the TERM store");
  console.error("run `spec glossary .` to regenerate the human view from the store");
  if (json) console.log(JSON.stringify({ ok: false }));
  process.exit(EXIT.FAILURE);
}

export const glossaryCommand = defineCommand({
  meta: {
    name: "glossary",
    description:
      "Generate GLOSSARY.md from the TERM store (byte-stable); --migrate parses GLOSSARY.md into TERM-001..N; --check fails on drift (committed != generated)",
  },
  args: {
    platformDir: {
      type: "positional",
      required: false,
      description: "Platform directory containing spec-engine/ (default: cwd)",
    },
    migrate: {
      type: "boolean",
      description: "One-time: parse the committed GLOSSARY.md into TERM-001..N (idempotent-skip)",
    },
    check: {
      type: "boolean",
      description: "Fail (exit 1) if the committed GLOSSARY.md differs from the generated output",
    },
    json: { type: "boolean", description: "Emit a JSON result instead of the text summary" },
  },
  async run({ args }) {
    const platformDir = resolvePlatform(args.platformDir as string | undefined);
    const json = Boolean(args.json);
    if (args.migrate) {
      await migrateGlossary(platformDir, json);
    } else if (args.check) {
      checkGlossary(platformDir, json);
    } else {
      await writeGlossary(platformDir, json);
    }
  },
});
