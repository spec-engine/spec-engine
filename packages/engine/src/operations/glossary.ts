// packages/engine/src/operations/glossary.ts
//
// The GLOSSARY.md round-trip. The committed glossary is generated from the
// TERM store, never hand-edited: a fixed header, terms in id order, a section
// heading once per change, one bullet per term, a single trailing newline. No
// date or random value touches the output, so two runs are byte-identical.
// The one-time migration parses an existing GLOSSARY.md into TERM-001..N
// through the single validateAndWrite seam; generation writes the derived
// human view, which is not a domain file.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Diagnostic, DiagnosticCode, validateAndWrite } from "@spec-engine/shared";
import { localToday } from "../authoring/edit";
import { specPaths } from "../constants";
import { fail, type OpFailure } from "./_result";

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
 * @spec CHCK-020
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

export type MigrateGlossaryResult =
  | { ok: true; skipped: true; existing: number }
  | { ok: true; skipped: false; migrated: number; file: string };

/**
 * One-time migration: parse the committed GLOSSARY.md into TERM-001..N and
 * write them through the seam. Idempotent: a TERM store that already holds
 * entries is left alone and reported as skipped.
 * @spec CHCK-021
 */
export async function migrateGlossary(
  platformDir: string,
): Promise<MigrateGlossaryResult | OpFailure> {
  const { abs: specPath, rel: relFile } = specPaths(platformDir, TERM_KEY);
  if (!existsSync(specPath)) {
    return fail("not_found", `no TERM domain (expected ${relFile} under ${platformDir})`);
  }
  const domain = JSON.parse(readFileSync(specPath, "utf8")) as {
    requirements?: unknown[];
    [k: string]: unknown;
  };
  const existing = Array.isArray(domain.requirements) ? domain.requirements : [];
  if (existing.length > 0) return { ok: true, skipped: true, existing: existing.length };
  const gPath = glossaryPath(platformDir);
  if (!existsSync(gPath)) {
    return fail("not_found", `no GLOSSARY.md to migrate (expected ${gPath})`);
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
    return fail("invalid_domain_file", res.diagnostics.map((d) => d.detail).join("\n"), {
      diagnostics: res.diagnostics,
    });
  }
  return { ok: true, skipped: false, migrated: parsed.length, file: relFile };
}

/** Generate GLOSSARY.md from the store and overwrite the committed file. */
export async function writeGlossary(
  platformDir: string,
): Promise<{ ok: true; generated: number; file: string }> {
  const terms = readStoreTerms(platformDir);
  await Bun.write(glossaryPath(platformDir), generateGlossary(terms));
  return { ok: true, generated: terms.length, file: "GLOSSARY.md" };
}

/**
 * The `spec check` probe (drift audit, statement 5): null when the committed
 * GLOSSARY.md matches the TERM store (or there is nothing to compare — no
 * terms, or no committed glossary); a warning-severity GLOSSARY_DRIFT
 * diagnostic when they disagree. Same byte-comparison as `--check` below, but
 * surfaced inside every `spec check` run instead of only this repo's CI fence.
 */
// @spec CHCK-024
export function glossaryDriftDiagnostic(platformDir: string): Diagnostic | null {
  const terms = readStoreTerms(platformDir);
  if (terms.length === 0) return null;
  const gPath = glossaryPath(platformDir);
  if (!existsSync(gPath)) return null;
  const generated = generateGlossary(terms);
  const committed = readFileSync(gPath, "utf8");
  if (generated === committed) return null;
  return {
    code: DiagnosticCode.GLOSSARY_DRIFT,
    severity: "warning",
    repo: null,
    source_file: "GLOSSARY.md",
    line: 0,
    req_id: null,
    detail:
      "GLOSSARY.md does not match the TERM store — run `spec glossary .` to regenerate the human view",
  };
}

/**
 * The drift fence: regenerate into a buffer and compare byte-for-byte with the
 * committed GLOSSARY.md. Clean when equal; drift otherwise.
 * @spec CHCK-022
 */
export function checkGlossary(platformDir: string): { ok: true; clean: boolean } {
  const generated = generateGlossary(readStoreTerms(platformDir));
  const gPath = glossaryPath(platformDir);
  const committed = existsSync(gPath) ? readFileSync(gPath, "utf8") : "";
  return { ok: true, clean: generated === committed };
}
