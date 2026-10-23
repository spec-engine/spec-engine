import {
  formatStatementFinding,
  RULE_ZERO,
  ruleSeverity,
  statementFindings,
} from "@spec-engine/shared";
import { readCheckConfig } from "../check/severity";
import type { OpWarning } from "../operations/_result";

export interface StatementRulesVerdict {
  /** The refusal text when a rule graded `error` breaks, else null. */
  refusal: string | null;
  /** Findings of rules graded `warning`, written anyway. */
  warnings: OpWarning[];
}

/**
 * Judges a to-be-written statement under the platform's check.json. A rule
 * with no configured severity takes its `ruleSeverity` default. TERM
 * statements are definitions and are never judged; a blank statement is the
 * schema validator's refusal.
 * @spec REQ-060
 * @spec REQ-069
 * @spec CHRT-022
 * @spec CHCK-048
 */
export function statementRulesVerdict(
  platformDir: string,
  key: string,
  statement: string,
): StatementRulesVerdict {
  if (key === "TERM" || statement.trim() === "") return { refusal: null, warnings: [] };
  const config = readCheckConfig(platformDir);
  if (!config.ok) return { refusal: config.detail, warnings: [] };
  const rules = config.config.statementRules;
  const findings = statementFindings(statement, rules);
  const errors = findings.filter((f) => ruleSeverity(f.rule, rules) === "error");
  if (errors.length > 0) {
    return { refusal: [...errors.map(formatStatementFinding), RULE_ZERO].join("\n"), warnings: [] };
  }
  return {
    refusal: null,
    warnings: findings.map((f) => ({
      kind: "statement",
      text: `warning — ${formatStatementFinding(f)}`,
    })),
  };
}
