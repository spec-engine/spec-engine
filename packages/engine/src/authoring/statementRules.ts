import { formatStatementFinding, RULE_ZERO, statementFindings } from "@spec-engine/shared";
import { readCheckConfig } from "../check/severity";

/**
 * The refusal text for a to-be-written statement that breaks an enabled
 * statement rule under the platform's check.json, or null when it passes.
 * TERM statements are definitions and are never judged; a blank statement is
 * the schema validator's refusal.
 * @spec REQ-060
 * @spec CHRT-022
 * @spec CHCK-048
 */
export function statementRulesRefusal(
  platformDir: string,
  key: string,
  statement: string,
): string | null {
  if (key === "TERM" || statement.trim() === "") return null;
  const config = readCheckConfig(platformDir);
  if (!config.ok) return config.detail;
  const findings = statementFindings(statement, config.config.statementRules);
  if (findings.length === 0) return null;
  return [...findings.map(formatStatementFinding), RULE_ZERO].join("\n");
}
