import { parseDomainText, type SpecRequirement, validateAndWrite } from "@spec-engine/shared";
import { localToday } from "../authoring/edit";
import {
  grammarRefusalText,
  grammarWarningText,
  judgeStatementGrammar,
} from "../authoring/grammar";
import { statementRulesVerdict } from "../authoring/statementRules";
import { gitShow, newestReleaseTag } from "../base/gitBase";
import type { PossibleDuplicate } from "../check/duplicates";
import { displayStatus, locateEntry, splitList } from "./_envelope";
import type { DuplicateScan } from "./_index";
import { fail, type OpFailure, type OpWarning } from "./_result";
import { unresolvableRefWarnings } from "./mint";

/** The fields an amend may change. An absent key leaves the field byte-identical. */
export interface AmendFields {
  statement?: string | undefined;
  /** `null` clears the field. */
  why?: string | null | undefined;
  /** Replaces the whole list; an empty list clears it. */
  relates?: string[] | undefined;
  /** Appended as `amends-via` provenance. */
  issue?: string | undefined;
  /** TERM ids only. */
  term?: string | undefined;
  aliases?: string[] | undefined;
}

export interface AmendInput {
  platformDir: string;
  id: string;
  fields: AmendFields;
}

export interface AmendResult {
  ok: true;
  id: string;
  file: string;
  /** Sorted names of the fields that changed: requirement, why, relates, term, issue, aliases. */
  fieldsChanged: string[];
  /** Empty unless the amend changed the statement. */
  possibleDuplicates: PossibleDuplicate[];
  warnings: OpWarning[];
}

/**
 * The newest release tag whose copy of `relFile` holds `id`, or null when the
 * id is unreleased.
 * @spec REQ-044
 * @spec REQ-047
 */
function releaseHolding(platformDir: string, relFile: string, id: string): string | null {
  const tag = newestReleaseTag(platformDir);
  if (tag === null) return null;
  const text = gitShow(platformDir, tag, relFile);
  if (text === null) return null;
  const parsed = parseDomainText(text, relFile);
  return parsed.ok && parsed.data.requirements.some((r) => r.id === id) ? tag : null;
}

const PROMISE_FIELDS = ["statement", "why", "term", "aliases"] as const;

/**
 * Status gate, then the release gate for an Active entry's promise fields.
 * Null when the amend may proceed.
 * @spec REQ-044
 * @spec REQ-062
 * @spec REQ-064
 */
function gateRejection(
  platformDir: string,
  relFile: string,
  req: SpecRequirement,
  fields: AmendFields,
): OpFailure | null {
  const { id } = req;
  const statusLc = req.status.toLowerCase();
  if (statusLc !== "active" && statusLc !== "draft") {
    return fail(
      "conflict",
      `${id} is ${displayStatus(req.status)} — only Active/Draft entries amend (a superseded entry is history; supersede its successor instead)`,
    );
  }
  if (statusLc !== "active") return null;
  if (!PROMISE_FIELDS.some((f) => fields[f] !== undefined)) return null;
  const tag = releaseHolding(platformDir, relFile, id);
  if (tag === null) return null;
  return fail(
    "conflict",
    `${id} is released in ${tag} — its promise is immutable. ` +
      `Run \`spec supersede ${id}\` to change the statement or why; ` +
      "pass only --relates or --issue to amend its metadata in place.",
  );
}

/** Apply the named fields; returns what changed and the values to scan for `@` refs. */
function applyFields(
  req: SpecRequirement,
  fields: AmendFields,
): { fieldsChanged: string[]; refValues: string[] } {
  const fieldsChanged: string[] = [];
  const refValues: string[] = [];
  if (fields.statement !== undefined) {
    req.statement = fields.statement;
    fieldsChanged.push("requirement");
    refValues.push(fields.statement);
  }
  if (fields.why !== undefined) {
    req.why = fields.why;
    fieldsChanged.push("why");
    refValues.push(fields.why ?? "");
  }
  // @spec REQ-050
  // @spec REQ-051
  if (fields.relates !== undefined) {
    req.relates = splitList(fields.relates);
    fieldsChanged.push("relates");
  }
  // @spec REQ-033
  // @spec REQ-034
  if (fields.term !== undefined) {
    req.term = fields.term;
    fieldsChanged.push("term");
    refValues.push(fields.term);
  }
  if (fields.issue !== undefined) {
    // @spec PROV-003
    req.issues.push({ role: "amends-via", id: fields.issue });
    fieldsChanged.push("issue");
  }
  if (fields.aliases !== undefined) {
    req.aliases = fields.aliases;
    fieldsChanged.push("aliases");
  }
  return { fieldsChanged, refValues };
}

/**
 * @param scan how this surface finds the possible duplicates after the write.
 * @spec REQ-044
 * @spec REQ-048
 * @spec SCHM-024
 * @spec REQ-070
 */
export async function amend(
  input: AmendInput,
  scan: DuplicateScan,
): Promise<AmendResult | OpFailure> {
  const { platformDir, id, fields } = input;
  const located = await locateEntry(platformDir, id);
  if (!located.ok) return located;
  const { key, specPath, relFile, domain, req } = located;

  const rejection = gateRejection(platformDir, relFile, req, fields);
  if (rejection !== null) return rejection;

  const warnings: OpWarning[] = [];
  if (fields.statement !== undefined) {
    const verdict = await judgeStatementGrammar(platformDir, key, fields.statement);
    if (!verdict.ok) {
      if (verdict.severity === "error") {
        return fail("usage", grammarRefusalText("", verdict).slice(2));
      }
      warnings.push({ kind: "grammar", text: grammarWarningText("", verdict).slice(2) });
    }
    const rules = statementRulesVerdict(platformDir, key, fields.statement);
    if (rules.refusal !== null) return fail("usage", rules.refusal);
    warnings.push(...rules.warnings);
  }

  const { fieldsChanged, refValues } = applyFields(req, fields);
  warnings.push(...unresolvableRefWarnings(platformDir, refValues));

  domain.updated = localToday();
  const res = await validateAndWrite(specPath, domain, relFile);
  if (!res.ok) {
    return fail("invalid_domain_file", res.diagnostics.map((d) => d.detail).join("\n"), {
      diagnostics: res.diagnostics,
      warnings,
    });
  }
  const possibleDuplicates =
    fields.statement === undefined ? [] : await scan(fields.statement, [id]);
  return {
    ok: true,
    id,
    file: relFile,
    fieldsChanged: [...fieldsChanged].sort(),
    possibleDuplicates,
    warnings,
  };
}
