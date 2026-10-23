import { existsSync } from "node:fs";
import { ID_RE, KEY_RE } from "@spec-engine/shared";
import { readCheckConfig } from "../check/severity";
import { type StatementRuleRow, statementRuleRows } from "../check/statementRules";
import { specPaths } from "../constants";
import { locateEntry } from "./_envelope";
import { fail, type OpFailure } from "./_result";

export interface LintInput {
  platformDir: string;
  /** A domain key or a requirement id; absent: the whole platform. */
  target?: string | undefined;
  /** Judge Draft requirements as well as Active ones. */
  all?: boolean | undefined;
}

export interface LintResult {
  ok: true;
  findings: StatementRuleRow[];
}

/**
 * @spec CHCK-050
 * @spec CHCK-051
 */
export async function lint(input: LintInput): Promise<LintResult | OpFailure> {
  const { platformDir, target } = input;
  const config = readCheckConfig(platformDir);
  if (!config.ok) return fail("usage", config.detail);
  const statuses = new Set(input.all ? ["active", "draft"] : ["active"]);
  let keys: string[] | undefined;
  let id: string | undefined;
  if (target !== undefined && ID_RE.test(target)) {
    const located = await locateEntry(platformDir, target);
    if (!located.ok) return located;
    keys = [located.key];
    id = target;
  } else if (target !== undefined && KEY_RE.test(target)) {
    const { abs, rel } = specPaths(platformDir, target);
    if (!existsSync(abs)) return fail("not_found", `no domain ${target} (expected ${rel})`);
    keys = [target];
  } else if (target !== undefined) {
    return fail("usage", `${target} is neither a domain key nor a requirement id`);
  }
  const findings = await statementRuleRows(platformDir, config.config.statementRules, {
    keys,
    id,
    statuses,
  });
  return { ok: true, findings };
}
