// packages/engine/src/operations/_envelope.ts
//
// The domain-file substrate every lifecycle operation shares: read one
// SPEC.json through the shared schema, locate the entry an id names, and word
// the refusals every locate can raise. Nothing here writes.

import { existsSync } from "node:fs";
import { parseDomainText, type SpecDomain, type SpecRequirement } from "@spec-engine/shared";
import { specPaths } from "../constants";
import { fail, type OpFailure } from "./_result";

export interface EnvelopeFile {
  ok: true;
  key: string;
  specPath: string;
  /** Platform-relative, e.g. `spec-engine/BILLING/SPEC.json`. */
  relFile: string;
  domain: SpecDomain;
  /** The same array as `domain.requirements`; a push here lands in the envelope. */
  requirements: SpecRequirement[];
}

/** The domain key an id carries: everything before the first dash. */
export function domainKeyOf(id: string): string {
  return id.slice(0, id.indexOf("-"));
}

/** Capitalized status for a refusal message; the raw string when empty. */
export function displayStatus(raw: string): string {
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw;
}

/**
 * Read a domain's SPEC.json through the shared schema. `not_found` when the
 * file is absent (the detail defaults to the phrasing `spec amend` has always
 * used; a caller may word its own), `invalid_domain_file` when the bytes are
 * not JSON or the envelope fails the schema.
 * @spec SCHM-030
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
  const parsed = parseDomainText(await Bun.file(specPath).text(), relFile);
  if (!parsed.ok) {
    if (parsed.reason === "not_json") {
      return fail("invalid_domain_file", `${relFile} is not valid JSON`);
    }
    return fail("invalid_domain_file", parsed.diagnostics.map((d) => d.detail).join("\n"), {
      diagnostics: parsed.diagnostics,
    });
  }
  const domain = parsed.data;
  return { ok: true, key, specPath, relFile, domain, requirements: domain.requirements };
}

export interface LocatedEntry extends EnvelopeFile {
  req: SpecRequirement;
}

/** The domain file and the entry an id names, or `not_found` for either. */
export async function locateEntry(
  platformDir: string,
  id: string,
  missingDomainDetail?: string,
): Promise<LocatedEntry | OpFailure> {
  const file = await readEnvelope(platformDir, domainKeyOf(id), missingDomainDetail);
  if (!file.ok) return file;
  const req = file.requirements.find((r) => r.id === id);
  if (req === undefined) return fail("not_found", `no entry ${id} in ${file.relFile}`);
  return { ...file, req };
}

/** The successor entry both `supersede` and `move` append, in the envelope's field order. */
export function successorEntry(
  id: string,
  fields: { statement: string; why: string; livesIn: string[]; issue?: string | undefined },
): SpecRequirement {
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
    aliases: [],
    cites: [],
  };
}
