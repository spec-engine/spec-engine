import { z } from "zod";
import { DiagnosticCode } from "./diagnostics";
import { ID_RE, KEY_RE } from "./domain";
import { STATEMENT_RULES } from "./statementRules";

const CODES = Object.values(DiagnosticCode) as [DiagnosticCode, ...DiagnosticCode[]];

const matchEntry = z
  .string()
  .refine((s) => KEY_RE.test(s) || ID_RE.test(s), "must be a domain key or a requirement id");

// @spec CHCK-036
// @spec CHCK-037
export const SeverityRuleSchema = z
  .object({
    code: z.enum(CODES),
    severity: z.enum(["error", "warning", "off"]),
    match: z.array(matchEntry).optional(),
  })
  .strict();

// @spec CHCK-057
export const StatementRulesConfigSchema = z
  .object({
    maxLength: z.number().int().positive().optional(),
    jargon: z.array(z.string().min(1)).optional(),
    exemptNames: z.array(z.string().min(1)).optional(),
    severity: z
      .partialRecord(z.enum(STATEMENT_RULES), z.enum(["error", "warning", "off"]))
      .optional(),
  })
  .strict();

export const CheckConfigSchema = z
  .object({
    // @spec SCHM-042
    $schema: z.string().optional(),
    severity: z.array(SeverityRuleSchema).default([]),
    statementRules: StatementRulesConfigSchema.optional(),
  })
  .strict();

export type SeverityRule = z.infer<typeof SeverityRuleSchema>;
export type CheckConfig = z.infer<typeof CheckConfigSchema>;

export type ParseCheckConfigResult =
  | { ok: true; config: CheckConfig }
  | { ok: false; detail: string };

/** check.json bytes to a validated config. `sourceFile` names the file in the failure detail. */
// @spec CHCK-039
export function parseCheckConfigText(text: string, sourceFile: string): ParseCheckConfigResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `${sourceFile}: not valid JSON: ${msg}` };
  }
  const result = CheckConfigSchema.safeParse(parsed);
  if (result.success) return { ok: true, config: result.data };
  const issue = result.error.issues[0];
  const path = issue && issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return { ok: false, detail: `${sourceFile}: ${path}: ${issue?.message ?? "invalid"}` };
}
