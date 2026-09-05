// packages/engine/src/operations/amend.ts
//
// Revise an unshipped requirement's fields in place: same id, no version
// change. Two gates before any write. Status: only Active and Draft entries
// amend; a superseded or deprecated entry is history. Bound tags: an Active
// entry that any code implements or verifies is shipped, and shipped truth is
// superseded, never edited under the tags that prove it. The bound-tag gate
// asks the caller for the requirement's tags from a freshly derived index, so
// a draft amend never touches the index at all.

import { type SpecRequirement, validateAndWrite } from "@spec-engine/shared";
import { localToday } from "../authoring/edit";
import {
  grammarRefusalText,
  grammarWarningText,
  judgeStatementGrammar,
} from "../authoring/grammar";
import { displayStatus, domainKeyOf, locateEntry } from "./_envelope";
import type { FreshTags } from "./_index";
import { fail, type OpFailure, type OpWarning } from "./_result";
import { unresolvableRefWarnings } from "./mint";

export type { FreshTags } from "./_index";

/** The fields an amend may change. An absent key leaves the field byte-identical. */
export interface AmendFields {
  statement?: string | undefined;
  /** `null` clears the field. */
  why?: string | null | undefined;
  livesIn?: string[] | undefined;
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
  /** Sorted names of the fields that changed: requirement, why, lives, term, issue, aliases. */
  fieldsChanged: string[];
  warnings: OpWarning[];
}

/** Status gate, then the bound-tag gate for an Active entry. Null when the amend may proceed. */
async function gateRejection(
  id: string,
  req: SpecRequirement,
  freshTags: FreshTags,
): Promise<OpFailure | null> {
  const statusLc = req.status.toLowerCase();
  if (statusLc !== "active" && statusLc !== "draft") {
    return fail(
      "conflict",
      `${id} is ${displayStatus(req.status)} — only Active/Draft entries amend (a superseded entry is history; supersede its successor instead)`,
    );
  }
  if (statusLc !== "active") return null;
  const bound = (await freshTags(id)).filter(
    (t) => t.kind === "implements" || t.kind === "verifies",
  );
  const site = bound[0];
  if (site === undefined) return null;
  return fail(
    "conflict",
    `${id} is shipped — ${bound.length} code tag(s) bind it (e.g. ${site.file}:${site.line}). ` +
      "A bound requirement is immutable; supersede it with a successor instead of amending in place.",
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
  if (fields.livesIn !== undefined) {
    req.livesIn = fields.livesIn;
    fieldsChanged.push("lives");
    refValues.push(...fields.livesIn);
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
 * @param freshTags how this surface derives current tags for the bound-tag
 *   gate: the CLI cold-rebuilds a throwaway index, the API re-indexes into
 *   its long-lived handle.
 * @spec REQ-035
 * @spec SCHM-024
 */
export async function amend(
  input: AmendInput,
  freshTags: FreshTags,
): Promise<AmendResult | OpFailure> {
  const { platformDir, id, fields } = input;
  const located = await locateEntry(platformDir, id);
  if (!located.ok) return located;
  const { specPath, relFile, domain, req } = located;

  const rejection = await gateRejection(id, req, freshTags);
  if (rejection !== null) return rejection;

  const warnings: OpWarning[] = [];
  if (fields.statement !== undefined) {
    const key = domainKeyOf(id);
    const verdict = await judgeStatementGrammar(platformDir, key, fields.statement);
    if (!verdict.ok) {
      if (verdict.severity === "error") {
        return fail("usage", grammarRefusalText("", verdict).slice(2));
      }
      warnings.push({ kind: "grammar", text: grammarWarningText("", verdict).slice(2) });
    }
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
  return { ok: true, id, file: relFile, fieldsChanged: [...fieldsChanged].sort(), warnings };
}
