import { validateAndWrite } from "@spec-engine/shared";
import { localToday } from "../authoring/edit";
import { statementRulesVerdict } from "../authoring/statementRules";
import { displayStatus, locateEntry } from "./_envelope";
import { fail, type OpFailure, type OpWarning } from "./_result";

export interface AcceptInput {
  platformDir: string;
  id: string;
}

export interface AcceptResult {
  ok: true;
  id: string;
  file: string;
  warnings: OpWarning[];
}

/**
 * @spec REQ-038
 * @spec REQ-040
 * @spec REQ-041
 * @spec SCHM-024
 * @spec REQ-060
 */
export async function accept(input: AcceptInput): Promise<AcceptResult | OpFailure> {
  const { platformDir, id } = input;
  const located = await locateEntry(platformDir, id);
  if (!located.ok) return located;
  const { specPath, relFile, domain, req } = located;

  if (req.status.toLowerCase() !== "draft") {
    return fail("conflict", `${id} is ${displayStatus(req.status)} — only a Draft entry accepts`);
  }

  const rules = statementRulesVerdict(platformDir, located.key, req.statement);
  if (rules.refusal !== null) return fail("usage", rules.refusal);

  req.status = "active";
  domain.updated = localToday();
  const res = await validateAndWrite(specPath, domain, relFile);
  if (!res.ok) {
    return fail("invalid_domain_file", res.diagnostics.map((d) => d.detail).join("\n"), {
      diagnostics: res.diagnostics,
    });
  }
  return { ok: true, id, file: relFile, warnings: rules.warnings };
}
