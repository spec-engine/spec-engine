// Reads SPEC.json directly: the grammar declaration is envelope config, not
// indexed state. Superseded and deprecated entries are never re-judged, and
// the TERM domain holds definitions, not behavior statements, so it is exempt.

import {
  type Diagnostic,
  DiagnosticCode,
  parseDomainText,
  parseEarsStatement,
  type SpecRequirement,
} from "@spec-engine/shared";
import { listDomainKeys } from "../authoring/domains";
import { specPaths } from "../constants";
import { findRequirementIdLine } from "../parser/requirementLine";

const CHECKED_STATUSES = new Set(["active", "draft"]);

interface DeclaredDomain {
  raw: string;
  severity: "warning" | "error";
  requirements: readonly SpecRequirement[];
}

/** Read one domain's envelope; null unless it declares `grammar: "ears"`.
 *  Malformed files are skipped — structural validation owns those. */
async function readDeclaredDomain(
  platformDir: string,
  key: string,
): Promise<DeclaredDomain | null> {
  const { abs, rel } = specPaths(platformDir, key);
  let raw: string;
  try {
    raw = await Bun.file(abs).text();
  } catch {
    return null;
  }
  const parsed = parseDomainText(raw, rel);
  if (!parsed.ok || parsed.data.grammar !== "ears") return null;
  return {
    raw,
    severity: parsed.data.grammarSeverity === "error" ? "error" : "warning",
    requirements: parsed.data.requirements,
  };
}

/** The STATEMENT_GRAMMAR rows for one declared domain. */
function rowsForDomain(key: string, domain: DeclaredDomain): Diagnostic[] {
  const rows: Diagnostic[] = [];
  const rawLines = domain.raw.split("\n");
  let lineCursor = 0;
  for (const req of domain.requirements) {
    // Resolve the line before the status filter so the cursor stays monotonic
    // across entries this pass skips.
    const found = findRequirementIdLine(rawLines, req.id, lineCursor);
    if (found >= 0) lineCursor = found + 1;
    if (!CHECKED_STATUSES.has(req.status.toLowerCase())) continue;
    const result = parseEarsStatement(req.statement);
    if (result.ok) continue;
    rows.push({
      code: DiagnosticCode.STATEMENT_GRAMMAR,
      severity: domain.severity,
      repo: null,
      source_file: specPaths("", key).rel,
      line: found >= 0 ? found + 1 : 0,
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
