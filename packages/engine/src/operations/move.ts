// packages/engine/src/operations/move.ts
//
// The cross-domain supersede: mint the successor as the next id in another
// domain, carrying the source entry's fields forward, and flip the source to
// superseded with a cross-domain `supersededBy`. Both envelopes validate
// before either is written, so a refusal never leaves one side applied.

import {
  type Diagnostic,
  type SpecDomain,
  type SpecRequirement,
  validateAndWrite,
  validateDomainFile,
} from "@spec-engine/shared";
import { nextRequirementId } from "../authoring/domains";
import { localToday } from "../authoring/edit";
import {
  grammarRefusalText,
  grammarWarningText,
  judgeStatementGrammar,
} from "../authoring/grammar";
import { deriveDomainVersion } from "../parser/domainJson";
import type { ReqTagRow } from "../resolve/format";
import { domainKeyOf, type EnvelopeFile, readEnvelope, successorEntry } from "./_envelope";
import type { FreshTags } from "./_index";
import { fail, type OpFailure, type OpWarning } from "./_result";
import { unresolvableRefWarnings } from "./mint";
import { toReqTagRows } from "./reads";

export interface MoveInput {
  platformDir: string;
  /** The Active source entry. */
  id: string;
  /** The normalized target domain key. Must already exist. */
  targetKey: string;
  /** Absent: copied from the source. */
  statement?: string;
  why?: string;
  livesIn?: string[];
  /** TERM domain only: keep the authored `specVersion`. A no-op elsewhere. */
  noBump?: boolean;
}

export interface MoveResult {
  ok: true;
  oldId: string;
  newId: string;
  fromFile: string;
  toFile: string;
  sourceSpecVersion: number | null;
  targetSpecVersion: number | null;
  retag: ReqTagRow[];
  warnings: OpWarning[];
}

interface MoveTarget {
  ok: true;
  source: EnvelopeFile;
  target: EnvelopeFile;
  req: SpecRequirement;
}

/** Both envelopes and the located Active source entry, or the first refusal. */
async function locateMove(
  platformDir: string,
  id: string,
  targetKey: string,
): Promise<MoveTarget | OpFailure> {
  const sourceKey = domainKeyOf(id);
  if (sourceKey === targetKey) {
    return fail(
      "usage",
      `${id} is already in ${targetKey} — use spec supersede for an in-domain revision`,
    );
  }
  const source = await readEnvelope(
    platformDir,
    sourceKey,
    `no domain ${sourceKey} (expected spec-engine/${sourceKey}/SPEC.json)`,
  );
  if (!source.ok) return source;
  const target = await readEnvelope(
    platformDir,
    targetKey,
    `no target domain ${targetKey} — run \`spec domain new ${targetKey}\` first`,
  );
  if (!target.ok) return target;

  const req = source.requirements.find((r) => r.id === id);
  if (req === undefined) return fail("not_found", `no entry ${id} in ${source.relFile}`);
  if (req.status.toLowerCase() !== "active") {
    return fail(
      "conflict",
      `${id} is ${req.status} — only Active requirements move (superseded/retired entries stay as history)`,
    );
  }
  return { ok: true, source, target, req };
}

/** The successor's fields: the input's, else the source's. */
function successorFields(
  input: MoveInput,
  req: SpecRequirement,
): { statement: string; why: string; livesIn: string[] } {
  const srcLives = (req.livesIn[0] ?? "").trim();
  return {
    statement: (input.statement ?? req.statement).trim(),
    why: (input.why ?? req.why ?? "").trim(),
    livesIn: input.livesIn ?? (srcLives === "" ? [] : [srcLives]),
  };
}

/**
 * The version one side reports after the edit. A requirement domain's is
 * derived from its own supersede graph: the source gains one edge, the target
 * gains none. The TERM domain bumps its authored `specVersion` unless `noBump`.
 * Both sides advance `updated`.
 * @spec REQ-036
 */
function versionSide(domain: SpecDomain, key: string, noBump: boolean): number | null {
  domain.updated = localToday();
  if (key !== "TERM") return deriveDomainVersion(domain.requirements);
  if (noBump) return null;
  const current = domain.specVersion ?? 1;
  const next = current + 1;
  domain.specVersion = next;
  return next;
}

/** Diagnostics from validating both envelopes, so neither is written when either fails. */
function validateBoth(m: MoveTarget): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const src = validateDomainFile(m.source.domain, m.source.relFile);
  if (!src.ok) diagnostics.push(...src.diagnostics);
  const tgt = validateDomainFile(m.target.domain, m.target.relFile);
  if (!tgt.ok) diagnostics.push(...tgt.diagnostics);
  return diagnostics;
}

/**
 * @param freshTags how this surface derives current tags for the retag
 *   worklist after the write.
 * @spec REQ-038
 * @spec SCHM-024
 */
export async function move(
  input: MoveInput,
  freshTags: FreshTags,
): Promise<MoveResult | OpFailure> {
  const { platformDir, id, targetKey } = input;
  const m = await locateMove(platformDir, id, targetKey);
  if (!m.ok) return m;
  const { source, target, req } = m;

  const fields = successorFields(input, req);
  if (fields.statement === "") {
    return fail("usage", `${id} has an empty Requirement — cannot move a blank statement`);
  }
  const warnings: OpWarning[] = [];
  if (input.statement !== undefined) {
    const verdict = await judgeStatementGrammar(platformDir, targetKey, fields.statement);
    if (!verdict.ok) {
      if (verdict.severity === "error") {
        return fail("usage", grammarRefusalText("", verdict).slice(2));
      }
      warnings.push({ kind: "grammar", text: grammarWarningText("", verdict).slice(2) });
    }
  }
  warnings.push(
    ...unresolvableRefWarnings(platformDir, [fields.statement, fields.why, ...fields.livesIn]),
  );

  const newId = await nextRequirementId(platformDir, targetKey);
  const sourceCurrent = source.domain.specVersion ?? 1;
  req.status = "superseded";
  req.supersededBy = newId;
  target.requirements.push(successorEntry(newId, fields));
  const noBump = Boolean(input.noBump);
  const sourceSpecVersion = versionSide(source.domain, source.key, noBump);
  const targetSpecVersion = versionSide(target.domain, target.key, noBump);
  req.supersededAtVersion = sourceSpecVersion ?? sourceCurrent;

  const diagnostics = validateBoth(m);
  if (diagnostics.length > 0) {
    return fail("invalid_domain_file", diagnostics.map((d) => d.detail).join("\n"), {
      diagnostics,
      warnings,
    });
  }
  await validateAndWrite(target.specPath, target.domain, target.relFile);
  await validateAndWrite(source.specPath, source.domain, source.relFile);

  const retag = toReqTagRows(await freshTags(id));
  return {
    ok: true,
    oldId: id,
    newId,
    fromFile: source.relFile,
    toFile: target.relFile,
    sourceSpecVersion,
    targetSpecVersion,
    retag,
    warnings,
  };
}
