import { existsSync } from "node:fs";
import { parseDomainText, type SpecDomain, type SpecRequirement } from "@spec-engine/shared";
import { listDomainKeys } from "../authoring/domains";
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

/** The first other domain file holding `id`, scanned in key order. */
async function scanForEntry(
  platformDir: string,
  id: string,
  skipKey: string,
): Promise<LocatedEntry | null> {
  for (const key of listDomainKeys(platformDir)) {
    if (key === skipKey) continue;
    const file = await readEnvelope(platformDir, key);
    if (!file.ok) continue;
    const req = file.requirements.find((r) => r.id === id);
    if (req !== undefined) return { ...file, req };
  }
  return null;
}

/**
 * The domain file and the entry an id names: the prefix's domain first, then
 * every other domain file. `not_found` when no file holds the entry; an
 * invalid prefix file still refuses as `invalid_domain_file`.
 * @spec REQ-048
 */
export async function locateEntry(
  platformDir: string,
  id: string,
  missingDomainDetail?: string,
): Promise<LocatedEntry | OpFailure> {
  const prefixKey = domainKeyOf(id);
  const file = await readEnvelope(platformDir, prefixKey, missingDomainDetail);
  if (!file.ok && file.reason !== "not_found") return file;
  const req = file.ok ? file.requirements.find((r) => r.id === id) : undefined;
  if (file.ok && req !== undefined) return { ...file, req };
  const scanned = await scanForEntry(platformDir, id, prefixKey);
  if (scanned !== null) return scanned;
  return file.ok ? fail("not_found", `no entry ${id} in ${file.relFile}`) : file;
}

/** Split each value on commas, trim, and drop empties. */
// @spec REQ-050
export function splitList(values: readonly string[]): string[] {
  return values
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/** What a successor takes over from its predecessor unless the input names it. */
export interface SuccessorFields {
  statement: string;
  why: string;
  livesIn: string[];
  verifiedIn: string[];
  relates: string[];
  issue?: string | undefined;
}

/**
 * The successor both `supersede` and `move` append: the given fields, the
 * predecessor's cites, aliases, term, and section, and no issue but the
 * `created` row.
 * @spec REQ-058
 * @spec REQ-053
 */
export function successorEntry(
  id: string,
  pred: SpecRequirement,
  fields: SuccessorFields,
): SpecRequirement {
  const entry: SpecRequirement = {
    id,
    status: "active",
    statement: fields.statement,
    why: fields.why === "" ? null : fields.why,
    supersedes: null,
    supersededBy: null,
    relates: fields.relates,
    livesIn: fields.livesIn,
    verifiedIn: fields.verifiedIn,
    issues: fields.issue ? [{ role: "created", id: fields.issue }] : [],
    aliases: [...pred.aliases],
    cites: pred.cites.map((c) => ({ ...c })),
  };
  if (pred.term !== undefined) entry.term = pred.term;
  if (pred.section !== undefined) entry.section = pred.section;
  return entry;
}
