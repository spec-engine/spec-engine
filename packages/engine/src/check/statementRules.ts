import {
  type Diagnostic,
  DiagnosticCode,
  formatStatementFinding,
  parseDomainText,
  ruleSeverity,
  type StatementRule,
  type StatementRulesConfig,
  statementFindings,
} from "@spec-engine/shared";
import { listDomainKeys } from "../authoring/domains";
import { specPaths } from "../constants";
import { findRequirementIdLine } from "../parser/requirementLine";

export interface StatementRuleRow {
  req_id: string;
  rule: StatementRule;
  detail: string;
  reason: string;
  source_file: string;
  line: number;
}

export interface StatementRuleScope {
  /** Domain keys to read; absent: every domain. */
  keys?: readonly string[] | undefined;
  /** One requirement id; absent: every requirement in the read domains. */
  id?: string | undefined;
  /** Lowercase statuses judged. */
  statuses: ReadonlySet<string>;
}

/** One domain's findings in file order. A missing or malformed file has none:
 *  structural validation owns those. */
async function domainRows(
  platformDir: string,
  key: string,
  config: StatementRulesConfig | undefined,
  scope: StatementRuleScope,
): Promise<StatementRuleRow[]> {
  const { abs, rel } = specPaths(platformDir, key);
  const raw = await Bun.file(abs)
    .text()
    .catch(() => null);
  if (raw === null) return [];
  const parsed = parseDomainText(raw, rel);
  if (!parsed.ok) return [];
  const rawLines = raw.split("\n");
  const rows: StatementRuleRow[] = [];
  let lineCursor = 0;
  for (const req of parsed.data.requirements) {
    const found = findRequirementIdLine(rawLines, req.id, lineCursor);
    if (found >= 0) lineCursor = found + 1;
    if (scope.id !== undefined && req.id !== scope.id) continue;
    if (!scope.statuses.has(req.status.toLowerCase())) continue;
    for (const f of statementFindings(req.statement, config)) {
      rows.push({ req_id: req.id, ...f, source_file: rel, line: found >= 0 ? found + 1 : 0 });
    }
  }
  return rows;
}

/** Every finding in scope, sorted by (source_file, line, req_id), rule order within a statement. */
// @spec CHRT-022
export async function statementRuleRows(
  platformDir: string,
  config: StatementRulesConfig | undefined,
  scope: StatementRuleScope,
): Promise<StatementRuleRow[]> {
  const rows: StatementRuleRow[] = [];
  for (const key of scope.keys ?? listDomainKeys(platformDir)) {
    if (key !== "TERM") rows.push(...(await domainRows(platformDir, key, config, scope)));
  }
  rows.sort(
    (a, b) =>
      a.source_file.localeCompare(b.source_file) ||
      a.line - b.line ||
      a.req_id.localeCompare(b.req_id),
  );
  return rows;
}

/** The STATEMENT_RULES rows for every Active statement, graded per rule. */
// @spec CHCK-068
export async function statementRulesDiagnostics(
  platformDir: string,
  config: StatementRulesConfig | undefined,
): Promise<Diagnostic[]> {
  const rows = await statementRuleRows(platformDir, config, { statuses: new Set(["active"]) });
  return rows.map((r) => ({
    code: DiagnosticCode.STATEMENT_RULES,
    severity: ruleSeverity(r.rule, config) === "warning" ? "warning" : "error",
    repo: null,
    source_file: r.source_file,
    line: r.line,
    req_id: r.req_id,
    detail: formatStatementFinding(r),
  }));
}
