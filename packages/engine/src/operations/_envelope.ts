// packages/engine/src/operations/_envelope.ts
//
// The domain-file substrate every lifecycle operation shares: read one
// SPEC.json envelope loosely (the write seam re-validates the whole object),
// locate the entry an id names, and word the two refusals that every locate
// can raise. Nothing here writes.

import { existsSync } from "node:fs";
import { specPaths } from "../constants";
import { fail, type OpFailure } from "./_result";

/** A requirement or term object inside the envelope, typed loosely on purpose. */
export interface EnvelopeRequirement {
  id: string;
  status?: string;
  statement?: string;
  why?: string | null;
  supersedes?: string | null;
  supersededBy?: string | null;
  relates?: string[];
  livesIn?: string[];
  issues?: unknown[];
  changedAtVersion?: number;
  supersededAtVersion?: number;
  deprecatedReason?: string;
  term?: string;
  aliases?: string[];
  cites?: Array<{ term: string; pinned: number }>;
  section?: string | null;
  [k: string]: unknown;
}

export interface Envelope {
  key?: string;
  specVersion?: number;
  requirements?: EnvelopeRequirement[];
  updated?: string;
  [k: string]: unknown;
}

export interface EnvelopeFile {
  ok: true;
  key: string;
  specPath: string;
  /** Platform-relative, e.g. `spec-engine/BILLING/SPEC.json`. */
  relFile: string;
  domain: Envelope;
  requirements: EnvelopeRequirement[];
}

/** The domain key an id carries: everything before the first dash. */
export function domainKeyOf(id: string): string {
  return id.slice(0, id.indexOf("-"));
}

/** Capitalized status for a refusal message; the raw string when empty. */
export function displayStatus(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Read a domain's SPEC.json. `not_found` when the file is absent (the detail
 * defaults to the phrasing `spec amend` has always used; a caller may word
 * its own), `invalid_domain_file` when the bytes are not JSON.
 */
export async function readEnvelope(
  platformDir: string,
  key: string,
  missingDetail?: string,
): Promise<EnvelopeFile | OpFailure> {
  const { abs: specPath, rel: relFile } = specPaths(platformDir, key);
  if (!existsSync(specPath)) {
    return fail(
      "not_found",
      missingDetail ?? `no domain ${key} (expected ${relFile} under ${platformDir})`,
    );
  }
  let domain: Envelope;
  try {
    domain = JSON.parse(await Bun.file(specPath).text()) as Envelope;
  } catch {
    return fail("invalid_domain_file", `${relFile} is not valid JSON`);
  }
  const requirements = Array.isArray(domain.requirements) ? domain.requirements : [];
  return { ok: true, key, specPath, relFile, domain, requirements };
}

export interface LocatedEntry extends EnvelopeFile {
  req: EnvelopeRequirement;
}

/** The domain file and the entry an id names, or `not_found` for either. */
export async function locateEntry(
  platformDir: string,
  id: string,
  missingDomainDetail?: string,
): Promise<LocatedEntry | OpFailure> {
  const file = await readEnvelope(platformDir, domainKeyOf(id), missingDomainDetail);
  if (!file.ok) return file;
  const req = file.requirements.find((r) => r?.id === id);
  if (req === undefined) return fail("not_found", `no entry ${id} in ${file.relFile}`);
  return { ...file, req };
}

/** The successor entry both `supersede` and `move` append, in the envelope's field order. */
export function successorEntry(
  id: string,
  fields: { statement: string; why: string; livesIn: string[]; issue?: string },
): EnvelopeRequirement {
  return {
    id,
    status: "active",
    statement: fields.statement,
    why: fields.why === "" ? null : fields.why,
    supersedes: null,
    supersededBy: null,
    relates: [],
    livesIn: fields.livesIn,
    issues: fields.issue ? [{ role: "created", id: fields.issue }] : [],
  };
}
