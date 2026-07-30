// packages/engine/src/check/grammar.ts
//
// The STATEMENT_GRAMMAR check pass. For every domain whose envelope declares
// `grammar: "ears"`, each Active/Draft statement is parsed against the five
// EARS shapes (shared/ears.ts); a nonconforming statement emits one
// diagnostic row at the domain's `grammarSeverity` (default warning).
//
// Reads the SPEC.json files straight from the filesystem — the grammar
// declaration is envelope config, not indexed state (no column, no
// SCHEMA_VERSION bump), and the check must reflect the tree as it is.
// Terminal-status entries (superseded/deprecated) are history and are never
// re-judged; the reserved TERM domain holds definitions, not behavior
// statements, and is exempt.
//
// Pure aside from reads: no writes, no process.exit, deterministic ordering
// by (source_file, line, req_id).

import { join } from "node:path";
import { type Diagnostic, DiagnosticCode, parseEarsStatement } from "@spec-engine/shared";
import { listDomainKeys } from "../authoring/domains";

const CHECKED_STATUSES = new Set(["active", "draft"]);

/** 1-based line of the literal `"id": "<id>"` in the raw JSON text (the same
 *  deterministic scan the parser uses); 0 when not found. */
function lineOf(rawText: string, id: string): number {
  const lines = rawText.split("\n");
  const needle = `"id": "${id}"`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return 0;
}

interface DeclaredDomain {
  raw: string;
  severity: "warning" | "error";
  requirements: Array<{ id?: unknown; status?: unknown; statement?: unknown }>;
}

/** Read one domain's envelope; null unless it declares `grammar: "ears"`.
 *  Malformed files are skipped — structural validation owns those. */
async function readDeclaredDomain(
  platformDir: string,
  key: string,
): Promise<DeclaredDomain | null> {
  try {
    const raw = await Bun.file(join(platformDir, "spec-engine", key, "SPEC.json")).text();
    const doc = JSON.parse(raw) as {
      grammar?: unknown;
      grammarSeverity?: unknown;
      requirements?: unknown;
    };
    if (doc.grammar !== "ears") return null;
    return {
      raw,
      severity: doc.grammarSeverity === "error" ? "error" : "warning",
      requirements: Array.isArray(doc.requirements) ? doc.requirements : [],
    };
  } catch {
    return null;
  }
}

/** The STATEMENT_GRAMMAR rows for one declared domain. */
function rowsForDomain(key: string, domain: DeclaredDomain): Diagnostic[] {
  const rows: Diagnostic[] = [];
  for (const req of domain.requirements) {
    if (typeof req?.id !== "string" || typeof req.statement !== "string") continue;
    const status = typeof req.status === "string" ? req.status.toLowerCase() : "";
    if (!CHECKED_STATUSES.has(status)) continue;
    const result = parseEarsStatement(req.statement);
    if (result.ok) continue;
    rows.push({
      code: DiagnosticCode.STATEMENT_GRAMMAR,
      severity: domain.severity,
      repo: null,
      source_file: `spec-engine/${key}/SPEC.json`,
      line: lineOf(domain.raw, req.id),
      req_id: req.id,
      detail: `${result.problem}. Expected one of:\n  ${result.expected}`,
    });
  }
  return rows;
}

/** All STATEMENT_GRAMMAR diagnostics for the platform, sorted. */
// @spec CHCK-008
export async function statementGrammarDiagnostics(platformDir: string): Promise<Diagnostic[]> {
  const rows: Diagnostic[] = [];
  for (const key of listDomainKeys(platformDir)) {
    if (key === "TERM") continue;
    const domain = await readDeclaredDomain(platformDir, key);
    if (domain !== null) rows.push(...rowsForDomain(key, domain));
  }
  rows.sort(
    (a, b) =>
      (a.source_file ?? "").localeCompare(b.source_file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.req_id ?? "").localeCompare(b.req_id ?? ""),
  );
  return rows;
}
