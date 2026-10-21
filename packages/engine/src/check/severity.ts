// packages/engine/src/check/severity.ts
//
// Adopter severity policy from `spec-engine/check.json`, applied to the
// finished diagnostic set so every surface grades identically.

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

/** 2 for an id match, 1 for a domain-key match, 0 for an unscoped rule, -1 when it does not apply. */
function specificity(rule: SeverityRule, row: Diagnostic): number {
  if (rule.code !== row.code) return -1;
  if (rule.match === undefined) return 0;
  const id = row.req_id;
  if (id === null) return -1;
  if (rule.match.includes(id)) return 2;
  const key = id.slice(0, id.lastIndexOf("-"));
  return rule.match.includes(key) ? 1 : -1;
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
    let bestScore = -1;
    for (const rule of rules) {
      const score = specificity(rule, row);
      if (score >= 0 && score >= bestScore) {
        best = rule;
        bestScore = score;
      }
    }
    if (best === undefined) out.push(row);
    else if (best.severity !== "off") out.push({ ...row, severity: best.severity });
  }
  return out;
}
