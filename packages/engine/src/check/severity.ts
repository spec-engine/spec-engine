import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CheckConfig,
  type Diagnostic,
  parseCheckConfigText,
  type SeverityRule,
} from "@spec-engine/shared";
import { CANONICAL_SPECS_DIR } from "../constants";

export const CHECK_CONFIG_REL = `${CANONICAL_SPECS_DIR}/check.json`;

/** The platform's check.json, or no rules when the file is absent. */
export function readCheckConfig(
  platformDir: string,
): { ok: true; config: CheckConfig } | { ok: false; detail: string } {
  const path = join(platformDir, CHECK_CONFIG_REL);
  if (!existsSync(path)) return { ok: true, config: { severity: [] } };
  return parseCheckConfigText(readFileSync(path, "utf-8"), CHECK_CONFIG_REL);
}

const Specificity = {
  none: -1,
  code: 0,
  domain: 1,
  id: 2,
} as const;
type Specificity = (typeof Specificity)[keyof typeof Specificity];

function specificity(rule: SeverityRule, row: Diagnostic): Specificity {
  if (rule.code !== row.code) return Specificity.none;
  if (rule.match === undefined) return Specificity.code;
  const id = row.req_id;
  if (id === null) return Specificity.none;
  if (rule.match.includes(id)) return Specificity.id;
  const key = id.slice(0, id.lastIndexOf("-"));
  return rule.match.includes(key) ? Specificity.domain : Specificity.none;
}

/** Grade each row by its most specific rule; `off` drops the row. Ties go to the later rule. */
// @spec CHCK-036
// @spec CHCK-037
// @spec CHCK-038
export function applySeverity(
  rows: readonly Diagnostic[],
  rules: readonly SeverityRule[],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const row of rows) {
    let best: SeverityRule | undefined;
    let bestScore: Specificity = Specificity.none;
    for (const rule of rules) {
      const score = specificity(rule, row);
      if (score !== Specificity.none && score >= bestScore) {
        best = rule;
        bestScore = score;
      }
    }
    if (best === undefined) out.push(row);
    else if (best.severity !== "off") out.push({ ...row, severity: best.severity });
  }
  return out;
}
