// Two validation tiers. This schema hard-rejects a file that is not a
// well-formed envelope (INVALID_DOMAIN_FILE). `status` and `issues[].role` stay
// `z.string().min(1)`, never `z.enum`, so a bad status or role round-trips here
// and is diagnosed downstream instead of rejecting the whole file.
//
// shared cannot import from engine, so ID_RE and KEY_RE live here and the
// engine re-exports them.

import { z } from "zod";
import { type Diagnostic, DiagnosticCode } from "./diagnostics";

export const ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;
export const KEY_RE = /^[A-Z][A-Z0-9]*$/;

// `id` is an opaque tracker key, never a requirement id: ID_RE is deliberately
// not applied, so a KEY-NNN-shaped issue id stores verbatim.
export const SpecIssueSchema = z
  .object({
    role: z.string().min(1),
    id: z.string().min(1),
  })
  .strict();

// `term` is checked against ID_RE at check time, not here, and a stale `pinned`
// is TERM_DRIFT, not a structural reject.
export const SpecCiteSchema = z
  .object({
    term: z.string(),
    pinned: z.number().int(),
  })
  .strict();

/** Retired entry keys: read and ignored, never written back. */
const LEGACY_ENTRY_KEYS = ["livesIn", "verifiedIn"] as const;

// @spec SCHM-037
export const SpecRequirementSchema = z
  .object({
    id: z.string().regex(ID_RE),
    status: z.string().min(1),
    statement: z.string().min(1),
    why: z.string().nullable().optional(),
    supersedes: z.string().nullable().optional(),
    supersededBy: z.string().nullable().optional(),
    relates: z.array(z.string()).optional().default([]),
    livesIn: z.unknown().optional(),
    verifiedIn: z.unknown().optional(),
    issues: z.array(SpecIssueSchema).optional().default([]),
    changedAtVersion: z.number().int().optional(),
    // Stamped once at supersession and never recomputed, unlike
    // `changedAtVersion`, which the index forces to the current version for a
    // superseded entry. Absent on entries superseded before the field existed.
    supersededAtVersion: z.number().int().optional(),
    deprecatedReason: z.string().optional(),
    // A term is a requirement row in the TERM domain. Every optional field
    // added here must also be carried in `orderDomain`, or a write strips it.
    // @spec SCHM-016
    term: z.string().optional(),
    aliases: z.array(z.string()).optional().default([]),
    cites: z.array(SpecCiteSchema).optional().default([]),
    section: z.string().nullable().optional(),
  })
  .strict()
  .transform(({ livesIn: _l, verifiedIn: _v, ...entry }) => entry);

// `.strict()` on both objects: an unknown key (`__proto__`, a typo) rejects.
export const SpecDomainSchema = z
  .object({
    key: z.string().regex(KEY_RE),
    owner: z.string().nullable().optional(),
    // @spec SCHM-020
    // @spec SCHM-021
    // Only the TERM domain authors a specVersion: a term revision adds no
    // supersede edge, so its version cannot be derived. A requirement domain's
    // version is derived; fence_no_authored_specversion keeps it unauthored.
    specVersion: z.number().int().positive().optional(),
    updated: z.string(),
    // @spec CHRT-010
    scope: z.string().nullable().optional(),
    // Enums, not free strings: a typo'd grammar must reject, never mean freeform.
    // @spec SCHM-010
    grammar: z.enum(["ears", "freeform"]).optional(),
    grammarSeverity: z.enum(["warning", "error"]).optional(),
    requirements: z.array(SpecRequirementSchema),
  })
  .strict();

export type SpecIssue = z.infer<typeof SpecIssueSchema>;
export type SpecCite = z.infer<typeof SpecCiteSchema>;
export type SpecRequirement = z.infer<typeof SpecRequirementSchema>;
export type SpecDomain = z.infer<typeof SpecDomainSchema>;

/** Best-effort `req_id` for a diagnostic; never load-bearing. */
function reqIdForIssuePath(input: unknown, path: readonly PropertyKey[]): string | null {
  if (path.length < 2 || path[0] !== "requirements" || typeof path[1] !== "number") {
    return null;
  }
  const reqs = (input as { requirements?: unknown } | null | undefined)?.requirements;
  if (!Array.isArray(reqs)) return null;
  const candidate = (reqs[path[1]] as { id?: unknown } | undefined)?.id;
  return typeof candidate === "string" ? candidate : null;
}

/** Both the index reader and `validateAndWrite` call this, so their diagnostics cannot diverge. */
export function validateDomainFile(
  input: unknown,
  sourceFile: string,
): { ok: true; data: SpecDomain } | { ok: false; diagnostics: Diagnostic[] } {
  const result = SpecDomainSchema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  const diagnostics: Diagnostic[] = result.error.issues.map((issue) => ({
    code: DiagnosticCode.INVALID_DOMAIN_FILE,
    source_file: sourceFile,
    // 0, not null: the storage row's `line` is non-nullable, and the write
    // path must match the index path byte for byte.
    line: 0,
    repo: null,
    req_id: reqIdForIssuePath(input, issue.path),
    detail: `${issue.path.join(".")}: ${issue.message}`,
    severity: "error" as const,
  }));
  return { ok: false, diagnostics };
}

export type ParseDomainTextResult =
  | { ok: true; data: SpecDomain }
  | { ok: false; reason: "not_json" | "schema"; diagnostics: Diagnostic[] };

/**
 * The one way bytes become a domain envelope: JSON, then the structural
 * schema. Every SPEC.json reader calls this before touching a field, so no
 * code path holds an unvalidated envelope.
 * @spec SCHM-030
 */
export function parseDomainText(text: string, sourceFile: string): ParseDomainTextResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "not_json",
      diagnostics: [
        {
          code: DiagnosticCode.INVALID_DOMAIN_FILE,
          source_file: sourceFile,
          line: 0,
          repo: null,
          req_id: null,
          detail: `not valid JSON: ${msg}`,
          severity: "error",
        },
      ],
    };
  }
  const validated = validateDomainFile(parsed, sourceFile);
  if (validated.ok) return validated;
  return { ok: false, reason: "schema", diagnostics: validated.diagnostics };
}

/**
 * A fresh object in canonical key order, never a spread of the input, so no
 * untrusted key reaches a prototype-affecting sink.
 */
function orderDomain(d: SpecDomain) {
  return {
    key: d.key,
    owner: d.owner ?? null,
    specVersion: d.specVersion,
    updated: d.updated,
    // Every field below must be listed, or the whitelist rebuild strips it on
    // write. `undefined` is omitted by JSON.stringify, so an absent field stays
    // byte-identical; `?? null` normalizes an absent nullable to explicit null.
    scope: d.scope ?? null,
    grammar: d.grammar,
    grammarSeverity: d.grammarSeverity,
    requirements: d.requirements.map((r) => ({
      id: r.id,
      status: r.status,
      statement: r.statement,
      why: r.why ?? null,
      supersedes: r.supersedes ?? null,
      supersededBy: r.supersededBy ?? null,
      relates: r.relates,
      issues: r.issues.map((iss) => ({ role: iss.role, id: iss.id })),
      changedAtVersion: r.changedAtVersion,
      supersededAtVersion: r.supersededAtVersion,
      deprecatedReason: r.deprecatedReason,
      // Re-projected key by key so no untrusted key rides along.
      term: r.term,
      aliases: r.aliases,
      cites: r.cites.map((c) => ({ term: c.term, pinned: c.pinned })),
      section: r.section,
    })),
  };
}

type JsonObject = Record<string, unknown>;
type ProjectedDomain = JsonObject & { requirements: JsonObject[] };

function isDefaultValue(v: unknown): boolean {
  return v === undefined || v === null || (Array.isArray(v) && v.length === 0);
}

/** Equality over canonical projections, whose key order is fixed. */
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Patch `raw` in place from `before` to `next`, both canonical projections: an
 * unchanged field keeps its raw bytes, a changed field keeps its key position,
 * a field that turns default is written only where the raw carries the key.
 * @spec SCHM-032
 */
function patchFields(raw: JsonObject, before: JsonObject, next: JsonObject): void {
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    if (key === "requirements") continue;
    const v = next[key];
    if (sameValue(before[key], v)) continue;
    if (v === undefined) delete raw[key];
    else if (!isDefaultValue(v) || key in raw) raw[key] = v;
  }
}

/**
 * A new entry in the key order of `template`: the template's keys first
 * (a defaulted value only where the template carries the key), then every
 * remaining non-default field in canonical order.
 * @spec SCHM-033
 */
function shapeLike(template: JsonObject | undefined, next: JsonObject): JsonObject {
  if (template === undefined) return next;
  const out: JsonObject = {};
  for (const key of Object.keys(template)) {
    if (next[key] !== undefined) out[key] = next[key];
  }
  for (const [key, v] of Object.entries(next)) {
    if (!(key in out) && !isDefaultValue(v)) out[key] = v;
  }
  return out;
}

/**
 * The validated domain rendered onto the existing file's raw object, entries
 * in the validated order, matched to raw entries by id (duplicates in turn).
 * @spec SCHM-031
 */
function preserveShape(raw: JsonObject, rawDomain: SpecDomain, domain: SpecDomain): JsonObject {
  const before = orderDomain(rawDomain) as ProjectedDomain;
  const next = orderDomain(domain) as ProjectedDomain;
  patchFields(raw, before, next);

  const rawEntries = raw.requirements as JsonObject[];
  // @spec SCHM-038
  for (const entry of rawEntries) {
    for (const key of LEGACY_ENTRY_KEYS) delete entry[key];
  }
  const byId = new Map<string, number[]>();
  rawDomain.requirements.forEach((r, i) => {
    byId.set(r.id, [...(byId.get(r.id) ?? []), i]);
  });
  const template = rawEntries[rawEntries.length - 1];
  raw.requirements = next.requirements.map((entry, i) => {
    const idx = byId.get(domain.requirements[i]?.id ?? "")?.shift();
    if (idx === undefined) return shapeLike(template, entry);
    const rawEntry = rawEntries[idx] as JsonObject;
    patchFields(rawEntry, before.requirements[idx] as JsonObject, entry);
    return rawEntry;
  });
  return raw;
}

/**
 * Accept `serialized` only when it re-parses to `domain`, compared through the
 * canonical projection (an absent nullable field equals an explicit null).
 * @spec SCHM-034
 */
export function verifyRoundTrip(
  serialized: string,
  domain: SpecDomain,
  sourceFile: string,
): { ok: true } | { ok: false; diagnostics: Diagnostic[] } {
  const reparsed = parseDomainText(serialized, sourceFile);
  if (!reparsed.ok) return { ok: false, diagnostics: reparsed.diagnostics };
  if (sameValue(orderDomain(reparsed.data), orderDomain(domain))) return { ok: true };
  return {
    ok: false,
    diagnostics: [
      {
        code: DiagnosticCode.INVALID_DOMAIN_FILE,
        source_file: sourceFile,
        line: 0,
        repo: null,
        req_id: null,
        detail: "the shape-preserving rewrite does not re-parse to the validated domain",
        severity: "error",
      },
    ],
  };
}

/** The existing file's raw object and its validated form; null for a missing, non-JSON, or invalid file. */
async function readExisting(
  path: string,
  sourceFile: string,
): Promise<{ raw: JsonObject; data: SpecDomain } | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    return null;
  }
  const validated = validateDomainFile(raw, sourceFile);
  return validated.ok ? { raw: raw as JsonObject, data: validated.data } : null;
}

/**
 * Writes nothing unless `domain` passes the same `validateDomainFile` the
 * index reader uses. A new file takes the canonical key order; an existing
 * valid file is patched in its own shape, and the patch must re-parse to the
 * validated domain or nothing is written.
 *
 * @spec SCHM-015
 * @spec SCHM-031
 */
export async function validateAndWrite(
  path: string,
  domain: unknown,
  sourceFile?: string,
): Promise<{ ok: true } | { ok: false; diagnostics: Diagnostic[] }> {
  const src = sourceFile ?? path;
  const validated = validateDomainFile(domain, src);
  if (!validated.ok) {
    return { ok: false, diagnostics: validated.diagnostics };
  }
  const existing = await readExisting(path, src);
  if (existing === null) {
    await Bun.write(path, `${JSON.stringify(orderDomain(validated.data), null, 2)}\n`);
    return { ok: true };
  }
  const shaped = preserveShape(existing.raw, existing.data, validated.data);
  const serialized = `${JSON.stringify(shaped, null, 2)}\n`;
  const verdict = verifyRoundTrip(serialized, validated.data, src);
  if (!verdict.ok) return verdict;
  await Bun.write(path, serialized);
  return { ok: true };
}
