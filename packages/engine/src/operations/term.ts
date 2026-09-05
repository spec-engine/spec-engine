// packages/engine/src/operations/term.ts
//
// The glossary operations. A term is a requirement row in the reserved TERM
// domain: the definition in `statement`, the headword in `term`, synonyms in
// `aliases`, and each citing requirement pins the term version it read. Four
// operations: mint a term, list the store, revise a definition in place with
// the version bump citations drift against, and confirm a citation onto the
// term's current version or its successor.

import { type Diagnostic, validateAndWrite } from "@spec-engine/shared";
import { nextRequirementId } from "../authoring/domains";
import { localToday } from "../authoring/edit";
import { specPaths } from "../constants";
import {
  type EnvelopeFile,
  type EnvelopeRequirement,
  locateEntry,
  readEnvelope,
} from "./_envelope";
import { fail, type OpFailure, type OpWarning } from "./_result";
import { unresolvableRefWarnings } from "./mint";

export const TERM_KEY = "TERM";

function termStore(platformDir: string): Promise<EnvelopeFile | OpFailure> {
  return readEnvelope(
    platformDir,
    TERM_KEY,
    `no TERM domain (expected ${specPaths(platformDir, TERM_KEY).rel} under ${platformDir})`,
  );
}

function invalidFile(res: { diagnostics: Diagnostic[] }, warnings?: OpWarning[]): OpFailure {
  return fail("invalid_domain_file", res.diagnostics.map((d) => d.detail).join("\n"), {
    diagnostics: res.diagnostics,
    warnings,
  });
}

/** The next unused TERM id. `TERM-001` when the store does not exist yet. Nothing is written. */
export async function nextTermId(platformDir: string): Promise<{ ok: true; nextId: string }> {
  return { ok: true, nextId: await nextRequirementId(platformDir, TERM_KEY) };
}

export interface MintTermInput {
  platformDir: string;
  term: string;
  definition: string;
  aliases: string[];
  section?: string;
}

export interface MintTermResult {
  ok: true;
  id: string;
  file: string;
  warnings: OpWarning[];
}

/**
 * Append an Active term. `not_found` when the platform has no TERM store.
 * @spec REQ-033
 * @spec SCHM-024
 */
export async function mintTerm(input: MintTermInput): Promise<MintTermResult | OpFailure> {
  const { platformDir } = input;
  const warnings = unresolvableRefWarnings(platformDir, [input.term, input.definition]);
  const store = await termStore(platformDir);
  if (!store.ok) return fail(store.reason, store.detail, { warnings });
  const id = await nextRequirementId(platformDir, TERM_KEY);
  const entry: EnvelopeRequirement = {
    id,
    status: "active",
    statement: input.definition,
    term: input.term,
    why: null,
    supersedes: null,
    supersededBy: null,
    relates: [],
    livesIn: [],
    issues: [],
    aliases: input.aliases,
    cites: [],
    changedAtVersion: 1,
  };
  if (input.section !== undefined) entry.section = input.section;
  store.requirements.push(entry);
  store.domain.requirements = store.requirements;
  store.domain.updated = localToday();
  const res = await validateAndWrite(store.specPath, store.domain, store.relFile);
  if (!res.ok) return invalidFile(res, warnings);
  return { ok: true, id, file: store.relFile, warnings };
}

export interface TermListRow {
  id: string;
  term: string;
  status: string;
}

/** Every entry in the TERM store, sorted by id. An absent store lists nothing. */
export async function listTerms(
  platformDir: string,
): Promise<{ ok: true; rows: TermListRow[] } | OpFailure> {
  const store = await termStore(platformDir);
  if (!store.ok) {
    if (store.reason === "not_found") return { ok: true, rows: [] };
    return store;
  }
  const rows = store.requirements
    .map((r) => ({
      id: typeof r.id === "string" ? r.id : "",
      term: typeof r.term === "string" ? r.term : "",
      status: typeof r.status === "string" ? r.status : "",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, rows };
}

export interface ReviseTermInput {
  platformDir: string;
  id: string;
  definition: string;
  /** Keep the authored `specVersion`; the entry's `changedAtVersion` stays too. */
  noBump?: boolean;
}

export interface ReviseTermResult {
  ok: true;
  id: string;
  file: string;
  /** The bumped envelope version; null under `noBump`. */
  specVersion: number | null;
  warnings: OpWarning[];
}

/**
 * Rewrite a term's definition in place (same id) and bump the TERM envelope's
 * `specVersion`, the pin every citing requirement drifts against. Only an
 * Active or Draft term revises; a superseded term is history.
 * @spec REQ-033
 * @spec REQ-038
 * @spec SCHM-024
 */
export async function reviseTerm(input: ReviseTermInput): Promise<ReviseTermResult | OpFailure> {
  const { platformDir, id, definition } = input;
  const store = await termStore(platformDir);
  if (!store.ok) return store;
  const req = store.requirements.find((r) => r?.id === id);
  if (req === undefined) return fail("not_found", `no entry ${id} in ${store.relFile}`);
  const statusLc = (typeof req.status === "string" ? req.status : "").toLowerCase();
  if (statusLc !== "active" && statusLc !== "draft") {
    return fail(
      "conflict",
      `${id} is ${req.status} — only Active/Draft terms revise in place (supersede a shipped term instead)`,
    );
  }

  const warnings = unresolvableRefWarnings(platformDir, [definition]);
  req.statement = definition;
  let specVersion: number | null = null;
  if (!input.noBump) {
    const current = typeof store.domain.specVersion === "number" ? store.domain.specVersion : 1;
    specVersion = current + 1;
    store.domain.specVersion = specVersion;
    req.changedAtVersion = specVersion;
  }
  store.domain.updated = localToday();
  const res = await validateAndWrite(store.specPath, store.domain, store.relFile);
  if (!res.ok) return invalidFile(res, warnings);
  return { ok: true, id, file: store.relFile, specVersion, warnings };
}

export interface ConfirmTermInput {
  platformDir: string;
  /** The citing requirement. */
  reqId: string;
  /** The cited term as the citation names it today. */
  termId: string;
}

export interface ConfirmTermResult {
  ok: true;
  reqId: string;
  /** The term the citation now names: the input's, or its successor when superseded. */
  termId: string;
  pinned: number;
  file: string;
}

/**
 * The id a confirmed citation points at and the version it pins. An Active
 * term confirms to itself; a superseded term re-points to its successor.
 * Both pin the TERM envelope's current `specVersion`, which is what the index
 * caps every term's `changed_at_version` at, so the pin always clears drift.
 */
async function confirmTarget(
  platformDir: string,
  termId: string,
): Promise<{ ok: true; targetId: string; targetPin: number } | OpFailure> {
  const store = await termStore(platformDir);
  if (!store.ok) return store;
  const term = store.requirements.find((r) => r?.id === termId);
  if (term === undefined) return fail("not_found", `no term ${termId} in ${store.relFile}`);
  const targetPin = typeof store.domain.specVersion === "number" ? store.domain.specVersion : 1;
  const statusLc = (typeof term.status === "string" ? term.status : "").toLowerCase();
  if (statusLc !== "superseded") return { ok: true, targetId: termId, targetPin };
  const successorId = typeof term.supersededBy === "string" ? term.supersededBy : "";
  if (successorId === "") {
    return fail("conflict", `${termId} is superseded but names no successor`);
  }
  return { ok: true, targetId: successorId, targetPin };
}

/**
 * Re-pin a requirement's citation to the cited term's current version
 * (clears TERM_DRIFT); re-point it to the successor when the term is
 * superseded (clears SUPERSEDED_TERM_REFERENCED). Only an Active or Draft
 * citing entry re-pins; history keeps the citations it died with.
 * @spec CHCK-018
 * @spec CHCK-019
 * @spec REQ-038
 */
export async function confirmTerm(input: ConfirmTermInput): Promise<ConfirmTermResult | OpFailure> {
  const { platformDir, reqId, termId } = input;
  const target = await confirmTarget(platformDir, termId);
  if (!target.ok) return target;

  const located = await locateEntry(platformDir, reqId);
  if (!located.ok) return located;
  const { specPath, relFile, domain, req } = located;
  const rawStatus = typeof req.status === "string" ? req.status : "";
  const statusLc = rawStatus.toLowerCase();
  if (statusLc !== "active" && statusLc !== "draft") {
    return fail(
      "conflict",
      `${reqId} is ${rawStatus} — only Active/Draft entries re-pin a citation (a superseded entry is history)`,
    );
  }
  const cites = Array.isArray(req.cites) ? req.cites : [];
  const cite = cites.find((c) => c?.term === termId);
  if (cite === undefined) return fail("not_found", `${reqId} does not cite ${termId}`);

  cite.term = target.targetId;
  cite.pinned = target.targetPin;
  const res = await validateAndWrite(specPath, domain, relFile);
  if (!res.ok) return invalidFile(res);
  return { ok: true, reqId, termId: target.targetId, pinned: target.targetPin, file: relFile };
}
