// Every guard runs before the single envelope write.

import { type SpecDomain, type SpecRequirement, validateAndWrite } from "@spec-engine/shared";
import { nextRequirementId } from "../authoring/domains";
import { localToday } from "../authoring/edit";
import {
  grammarRefusalText,
  grammarWarningText,
  judgeStatementGrammar,
} from "../authoring/grammar";
import { statementRulesRefusal } from "../authoring/statementRules";
import { deriveDomainVersion } from "../parser/domainJson";
import type { ReqTagRow } from "../resolve/format";
import {
  displayStatus,
  type LocatedEntry,
  locateEntry,
  type SuccessorFields,
  splitList,
  successorEntry,
} from "./_envelope";
import type { FreshTags } from "./_index";
import { fail, type OpFailure, type OpWarning } from "./_result";
import { applyRetag } from "./_retag";
import { unresolvableRefWarnings } from "./mint";

export interface SupersedeInput {
  platformDir: string;
  /** The Active predecessor. */
  id: string;
  /** The successor's statement. */
  statement: string;
  /** Absent: copied from the predecessor. */
  why?: string | undefined;
  /** Replaces the predecessor's `relates`; an empty list clears it. Absent: copied. */
  relates?: string[] | undefined;
  /** TERM ids only. Absent: copied from the predecessor. */
  term?: string | undefined;
  aliases?: string[] | undefined;
  /** TERM domain only: keep the authored `specVersion`. A no-op elsewhere. */
  noBump?: boolean | undefined;
  /** Recorded as `supersedes-via` on the predecessor and `created` on the successor. */
  issue?: string | undefined;
}

export interface SupersedeResult {
  ok: true;
  oldId: string;
  newId: string;
  file: string;
  /** The domain version after the supersession; null under `noBump` on TERM. */
  specVersion: number | null;
  /** The predecessor's tag sites, rewritten to the successor. */
  retagged: ReqTagRow[];
  warnings: OpWarning[];
}

/**
 * The predecessor an id names, or the refusal: `not_found` for a missing
 * domain or entry, `conflict` for anything but an Active entry. Exported so
 * a surface that must prompt for the successor text can refuse first.
 */
export async function supersedeTarget(
  platformDir: string,
  id: string,
): Promise<LocatedEntry | OpFailure> {
  const located = await locateEntry(platformDir, id);
  if (!located.ok) return located;
  const { req } = located;
  const statusLc = req.status.toLowerCase();
  if (statusLc === "superseded") {
    return fail(
      "conflict",
      `${id} is already superseded by ${req.supersededBy} — supersede that successor instead`,
    );
  }
  if (statusLc !== "active") {
    return fail(
      "conflict",
      `${id} is ${displayStatus(req.status)} — only Active requirements supersede (amend a Draft in place)`,
    );
  }
  return located;
}

/**
 * The successor's why and relates: the input's, else the predecessor's.
 * @spec REQ-051
 * @spec REQ-063
 */
function successorFields(
  input: SupersedeInput,
  req: SpecRequirement,
): Omit<SuccessorFields, "statement" | "issue"> {
  return {
    why: (input.why ?? req.why ?? "").trim(),
    relates: input.relates === undefined ? [...req.relates] : splitList(input.relates),
  };
}

/**
 * The successor keeps the predecessor's headword and synonyms unless the
 * input names them.
 * @spec REQ-033
 * @spec REQ-034
 */
function applyTermOverrides(successor: SpecRequirement, input: SupersedeInput): void {
  const term = input.term?.trim();
  if (term) successor.term = term;
  if (input.aliases !== undefined) successor.aliases = input.aliases;
}

/** Flip the predecessor forward; the causing ticket rides along as provenance. */
// @spec PROV-003
function flipPredecessor(req: SpecRequirement, newId: string, issue?: string): void {
  req.status = "superseded";
  req.supersededBy = newId;
  if (issue) req.issues.push({ role: "supersedes-via", id: issue });
}

/**
 * Version both sides and stamp the predecessor's died-at value. A requirement
 * domain's version is derived from its supersede graph and no counter is
 * authored. The TERM domain bumps its authored `specVersion` (the pin every
 * citation drifts against) unless `noBump`, and its successor carries the
 * version it was minted at.
 * @spec REQ-036
 */
function applyVersionStage(
  domain: SpecDomain,
  req: SpecRequirement,
  successor: SpecRequirement,
  noBump: boolean,
): number | null {
  if (domain.key !== "TERM") {
    const derived = deriveDomainVersion(domain.requirements);
    req.supersededAtVersion = derived;
    return derived;
  }
  const currentVersion = domain.specVersion ?? 1;
  const reported = noBump ? null : currentVersion + 1;
  if (reported !== null) domain.specVersion = reported;
  req.supersededAtVersion = reported ?? currentVersion;
  successor.changedAtVersion = reported ?? currentVersion;
  return reported;
}

/**
 * @param freshTags how this surface derives current tags for the retag
 *   after the write: the CLI and MCP cold-rebuild a throwaway index,
 *   the API re-indexes into its long-lived handle.
 * @spec REQ-038
 * @spec SCHM-024
 */
export async function supersede(
  input: SupersedeInput,
  freshTags: FreshTags,
): Promise<SupersedeResult | OpFailure> {
  const { platformDir, id } = input;
  const target = await supersedeTarget(platformDir, id);
  if (!target.ok) return target;
  const { key, specPath, relFile, domain, requirements, req } = target;

  const warnings: OpWarning[] = [];
  const verdict = await judgeStatementGrammar(platformDir, key, input.statement);
  if (!verdict.ok) {
    if (verdict.severity === "error") {
      return fail("usage", grammarRefusalText("", verdict).slice(2));
    }
    warnings.push({ kind: "grammar", text: grammarWarningText("", verdict).slice(2) });
  }
  const refusal = statementRulesRefusal(platformDir, key, input.statement);
  if (refusal !== null) return fail("usage", refusal);
  const { why, relates } = successorFields(input, req);
  warnings.push(...unresolvableRefWarnings(platformDir, [input.statement, why]));

  // @spec REQ-049
  const newId = await nextRequirementId(platformDir, key);
  const issue = input.issue?.trim() || undefined;
  const successor = successorEntry(newId, req, {
    statement: input.statement,
    why,
    relates,
    issue,
  });
  applyTermOverrides(successor, input);
  flipPredecessor(req, newId, issue);
  requirements.push(successor);
  const specVersion = applyVersionStage(domain, req, successor, Boolean(input.noBump));
  domain.updated = localToday();

  const res = await validateAndWrite(specPath, domain, relFile);
  if (!res.ok) {
    return fail("invalid_domain_file", res.diagnostics.map((d) => d.detail).join("\n"), {
      diagnostics: res.diagnostics,
      warnings,
    });
  }
  const retagged = await applyRetag(platformDir, id, newId, freshTags);
  return { ok: true, oldId: id, newId, file: relFile, specVersion, retagged, warnings };
}
