// packages/engine/src/operations/supersede.ts
//
// Supersede a shipped requirement: flip the predecessor to superseded and
// pointed forward, mint the successor Active in the same domain, stamp the
// versions, write the envelope once, and answer with the retag worklist (the
// tag sites `spec check` reports as SUPERSEDED_REFERENCED until retagged).
// Every guard runs before the single write.

import { validateAndWrite } from "@spec-engine/shared";
import { nextRequirementId } from "../authoring/domains";
import { localToday } from "../authoring/edit";
import {
  grammarRefusalText,
  grammarWarningText,
  judgeStatementGrammar,
} from "../authoring/grammar";
import { deriveDomainVersion } from "../parser/domainJson";
import type { ReqTagRow } from "../resolve/format";
import {
  displayStatus,
  type Envelope,
  type EnvelopeRequirement,
  type LocatedEntry,
  locateEntry,
  successorEntry,
} from "./_envelope";
import type { FreshTags } from "./_index";
import { fail, type OpFailure, type OpWarning } from "./_result";
import { unresolvableRefWarnings } from "./mint";
import { toReqTagRows } from "./reads";

export interface SupersedeInput {
  platformDir: string;
  /** The Active predecessor. */
  id: string;
  /** The successor's statement. */
  statement: string;
  /** Absent: copied from the predecessor. */
  why?: string;
  /** Absent: the predecessor's first `livesIn` entry is carried forward. */
  livesIn?: string[];
  /** TERM ids only. Absent: copied from the predecessor. */
  term?: string;
  aliases?: string[];
  /** TERM domain only: keep the authored `specVersion`. A no-op elsewhere. */
  noBump?: boolean;
  /** Recorded as `supersedes-via` on the predecessor and `created` on the successor. */
  issue?: string;
}

export interface SupersedeResult {
  ok: true;
  oldId: string;
  newId: string;
  file: string;
  /** The domain version after the supersession; null under `noBump` on TERM. */
  specVersion: number | null;
  retag: ReqTagRow[];
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
  const statusLc = (typeof req.status === "string" ? req.status : "").toLowerCase();
  if (statusLc === "superseded") {
    return fail(
      "conflict",
      `${id} is already superseded by ${req.supersededBy} — supersede that successor instead`,
    );
  }
  if (statusLc !== "active") {
    const display = req.status ? displayStatus(req.status) : String(req.status);
    return fail(
      "conflict",
      `${id} is ${display} — only Active requirements supersede (amend a Draft in place)`,
    );
  }
  return located;
}

/** The successor's why and livesIn: the input's, else the predecessor's. */
function successorFields(
  input: SupersedeInput,
  req: EnvelopeRequirement,
): { why: string; livesIn: string[] } {
  const predWhy = typeof req.why === "string" ? req.why : "";
  const predLives =
    Array.isArray(req.livesIn) && req.livesIn.length > 0 ? String(req.livesIn[0]).trim() : "";
  const why = (input.why ?? predWhy).trim();
  const livesIn = input.livesIn ?? (predLives === "" ? [] : [predLives]);
  return { why, livesIn };
}

/**
 * A TERM successor keeps its headword and synonyms: the input's, else the
 * predecessor's.
 * @spec REQ-033
 * @spec REQ-034
 */
function successorTermFields(
  input: SupersedeInput,
  req: EnvelopeRequirement,
): { term: string | undefined; aliases: string[] } {
  const predTerm = typeof req.term === "string" ? req.term : undefined;
  const term = (input.term ?? predTerm)?.trim() || predTerm;
  const aliases =
    input.aliases ?? (Array.isArray(req.aliases) ? req.aliases.map((a) => String(a)) : []);
  return { term, aliases };
}

/** Flip the predecessor forward; the causing ticket rides along as provenance. */
// @spec PROV-003
function flipPredecessor(req: EnvelopeRequirement, newId: string, issue?: string): void {
  req.status = "superseded";
  req.supersededBy = newId;
  if (issue) {
    const issues = Array.isArray(req.issues) ? req.issues : [];
    issues.push({ role: "supersedes-via", id: issue });
    req.issues = issues;
  }
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
  domain: Envelope,
  requirements: EnvelopeRequirement[],
  req: EnvelopeRequirement,
  successor: EnvelopeRequirement,
  noBump: boolean,
): number | null {
  if (domain.key !== "TERM") {
    const derived = deriveDomainVersion(requirements);
    req.supersededAtVersion = derived;
    return derived;
  }
  const currentVersion = typeof domain.specVersion === "number" ? domain.specVersion : 1;
  const reported = noBump ? null : currentVersion + 1;
  if (reported !== null) domain.specVersion = reported;
  req.supersededAtVersion = reported ?? currentVersion;
  successor.changedAtVersion = reported ?? currentVersion;
  return reported;
}

/**
 * @param freshTags how this surface derives current tags for the retag
 *   worklist after the write: the CLI and MCP cold-rebuild a throwaway index,
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
  const { why, livesIn } = successorFields(input, req);
  warnings.push(...unresolvableRefWarnings(platformDir, [input.statement, why, ...livesIn]));

  const newId = await nextRequirementId(platformDir, key);
  const issue = input.issue?.trim() || undefined;
  flipPredecessor(req, newId, issue);
  const successor = successorEntry(newId, { statement: input.statement, why, livesIn, issue });
  if (key === "TERM") {
    const termFields = successorTermFields(input, req);
    if (termFields.term !== undefined) successor.term = termFields.term;
    successor.aliases = termFields.aliases;
  }
  requirements.push(successor);
  domain.requirements = requirements;
  const specVersion = applyVersionStage(
    domain,
    requirements,
    req,
    successor,
    Boolean(input.noBump),
  );
  domain.updated = localToday();

  const res = await validateAndWrite(specPath, domain, relFile);
  if (!res.ok) {
    return fail("invalid_domain_file", res.diagnostics.map((d) => d.detail).join("\n"), {
      diagnostics: res.diagnostics,
      warnings,
    });
  }
  const retag = toReqTagRows(await freshTags(id));
  return { ok: true, oldId: id, newId, file: relFile, specVersion, retag, warnings };
}
