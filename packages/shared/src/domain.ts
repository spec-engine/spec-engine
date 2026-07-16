// packages/shared/src/domain.ts
//
// Phase 17 keystone: the ONE zod schema for authored JSON domain files plus the
// single validation seam both the index reader (17-02) and every write surface
// (17-04/17-05) consume.
//
// Two-tier validation (research §Two-tier; Invariant #4):
//   - STRUCTURAL tier (this schema): hard-reject a file that is not a well-formed
//     domain envelope — kills the em-dash silent-zero. Fires INVALID_DOMAIN_FILE.
//   - SEMANTIC tier (downstream `validateStructure`): `status` and `issues[].role`
//     are `z.string().min(1)` here, NOT `z.enum(...)`, so a planted BAD_STATUS /
//     bad-role row ROUND-TRIPS through the structural tier and gets diagnosed
//     later instead of hard-rejecting the whole file. Never promote them to enums.
//
// One validator (VAL-02): both the read path (index reader) and the write path
// (`validateAndWrite`) call `validateDomainFile`, so their reject Diagnostics are
// byte-identical — a single function cannot fork.
//
// This is the runtime-validation seam, mirroring config.ts's `z.object` + `z.infer`
// posture. shared MUST NOT import from engine, so ID_RE / KEY_RE are defined here.

import { z } from "zod";
import { type Diagnostic, DiagnosticCode } from "./diagnostics";

// Canonical id / key grammars — the SINGLE source of truth (P3 consolidation).
// shared cannot import from engine, and engine imports shared, so these live
// here and the engine re-exports them (parser/grammar.ts, authoring/domains.ts).
//   ID_RE:  a requirement id, `KEY-NNN` (e.g. BILLING-009)
//   KEY_RE: a domain/envelope key, `KEY` (e.g. BILLING)
export const ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;
export const KEY_RE = /^[A-Z][A-Z0-9]*$/;

// `issues[]` item — `id` is the OPAQUE tracker payload (a Jira/GitHub key, etc).
// It is NEVER a requirement id: ID_RE is deliberately NOT applied to it, so a
// KEY-NNN-shaped issue id stores verbatim (PROV-02 opacity doctrine).
export const SpecIssueSchema = z
  .object({
    role: z.string().min(1),
    id: z.string().min(1),
  })
  .strict();

// `cites[]` item (Phase 6 / TERM-01) — a PINNED reference from a requirement to
// a glossary TERM. `term` is the cited TERM's id (a plain string here — ID_RE is
// enforced at check time, never as a structural reject, mirroring the two-tier
// note above), `pinned` the term's spec_version the citation was authored
// against (drift is a TERM_DRIFT diagnostic, not a structural reject). `.strict()`
// so an injected extra key on a citation hard-rejects (T-06-01 tampering).
export const SpecCiteSchema = z
  .object({
    term: z.string(),
    pinned: z.number().int(),
  })
  .strict();

// A single requirement item (STOR-01 shape). `status` / `issues[].role` are
// intentionally free strings at this tier — see the two-tier note above.
export const SpecRequirementSchema = z
  .object({
    id: z.string().regex(ID_RE),
    status: z.string().min(1),
    statement: z.string().min(1),
    why: z.string().nullable().optional(),
    supersedes: z.string().nullable().optional(),
    supersededBy: z.string().nullable().optional(),
    relates: z.array(z.string()).optional().default([]),
    // validate / round-trip only — NOT indexed this phase (research Open
    // Question #3; the Markdown parser ignores `Lives in:`, livesIn is
    // code-tag-derived). No new column, so no SCHEMA_VERSION bump.
    livesIn: z.array(z.string()).optional().default([]),
    issues: z.array(SpecIssueSchema).optional().default([]),
    changedAtVersion: z.number().int().optional(),
    // The envelope specVersion at the moment this requirement was superseded /
    // retired (stamped by `spec supersede` / `spec move`). Unlike
    // `changedAtVersion` — which the index recomputes and forces to the CURRENT
    // envelope version for a superseded entry — this is authored ONCE at the
    // supersession and never recomputed, so a lineage can show the true version
    // each entry died at. Absent (undefined) for Active entries and for
    // requirements superseded before this field existed (unrecoverable — no
    // back-fill). Carried in the orderDomain whitelist below or it is silently
    // stripped on write (the changedAtVersion strip-trap).
    supersededAtVersion: z.number().int().optional(),
    // TERM-01 (Phase 6): the four OPTIONAL glossary-term fields. A term IS a
    // requirement row (FORK 1 = reuse, not a parallel schema): `term` is the
    // glossary headword, `aliases` its synonyms, `cites` its pinned references
    // to other TERMs, `section` its GLOSSARY.md layout bucket (Wave F). All
    // optional so EVERY existing requirement stays valid; `aliases`/`cites`
    // default to `[]` like `relates`/`livesIn`. Each MUST also be carried in the
    // orderDomain whitelist below or it is silently stripped on write (the
    // scope/IN-01 strip-trap). `.strict()` stays intact (T-06-01 mitigation).
    // @spec SCHM-005
    term: z.string().optional(),
    aliases: z.array(z.string()).optional().default([]),
    cites: z.array(SpecCiteSchema).optional().default([]),
    section: z.string().nullable().optional(),
  })
  .strict();

// The domain envelope (STOR-02 shape). `.strict()` on both objects means an
// injected/unrecognized key (`__proto__`, `constructor`, typos) hard-rejects as
// INVALID_DOMAIN_FILE — the T-17-01 prototype-tampering mitigation.
export const SpecDomainSchema = z
  .object({
    key: z.string().regex(KEY_RE),
    owner: z.string().nullable().optional(),
    // @spec SCHM-008 — the authored envelope version counter is retired for
    // requirement domains: a domain's version is the DAG-derived projection
    // (SCHM-007), so a requirement (non-TERM) domain carries NO specVersion —
    // the field is optional here, and a deterministic gate
    // (scripts/arch-fences.sh: fence_no_authored_specversion) fails the build if
    // one is reintroduced on a non-TERM domain. Only the reserved TERM domain
    // keeps an authored specVersion — its in-place `spec term revise` bump is the
    // pin a citation's drift is measured against, and a revision adds no
    // supersede edge for the DAG to count, so term-drift cannot be derived.
    specVersion: z.number().int().positive().optional(),
    updated: z.string(),
    // @spec CHRT-003 — the per-domain charter sentence, carried ON the envelope.
    // Optional so a pre-charter domain stays valid; nullable so it round-trips
    // as an explicit null. A plain named string, NOT z.enum / a loose passthrough
    // — `.strict()` keeps rejecting every OTHER unknown key (the T-01-01
    // prototype-tampering mitigation), so whitelisting `scope` does not reopen the
    // door to `__proto__polluter`. NOT indexed — no column, no SCHEMA_VERSION bump.
    scope: z.string().nullable().optional(),
    requirements: z.array(SpecRequirementSchema),
  })
  .strict();

export type SpecIssue = z.infer<typeof SpecIssueSchema>;
export type SpecRequirement = z.infer<typeof SpecRequirementSchema>;
export type SpecDomain = z.infer<typeof SpecDomainSchema>;

/**
 * Attribute a zod issue to the offending requirement id when its path points at
 * `requirements[n].<field>` and that requirement carries a string `id`. Used only
 * to populate `Diagnostic.req_id` — best-effort context, never load-bearing.
 */
function reqIdForIssuePath(input: unknown, path: (string | number)[]): string | null {
  if (path.length < 2 || path[0] !== "requirements" || typeof path[1] !== "number") {
    return null;
  }
  const reqs = (input as { requirements?: unknown } | null | undefined)?.requirements;
  if (!Array.isArray(reqs)) return null;
  const candidate = (reqs[path[1]] as { id?: unknown } | undefined)?.id;
  return typeof candidate === "string" ? candidate : null;
}

/**
 * The single STRUCTURAL validation source (STOR-03 / VAL-02).
 *
 * Runs `SpecDomainSchema.safeParse`. On failure, maps every zod issue to the
 * shared `Diagnostic` shape (code INVALID_DOMAIN_FILE, error severity) so the
 * malformed file is rejected LOUDLY — never a silent-zero. On success returns the
 * parsed, defaults-applied domain.
 *
 * Both the index reader and `validateAndWrite` call THIS function, so the read
 * and write paths cannot produce diverging diagnostics.
 */
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
    // WR-02: storage-normalized `line`. A structural reject has no meaningful
    // source line (JSON.parse discarded positions), and the storage row shape
    // (`ParseDiagnostic.line`) is a non-nullable `number`. Emit 0 — NOT null —
    // so the write-path Diagnostic (validateAndWrite) and the index-path
    // ParseDiagnostic are TRULY byte-identical on `line`, not merely on
    // code/detail/severity. (Previously null here, coerced to 0 only on the
    // index path — the exact VAL-02 `line` drift WR-02 flags.)
    line: 0,
    repo: null,
    req_id: reqIdForIssuePath(input, issue.path),
    detail: `${issue.path.join(".")}: ${issue.message}`,
    severity: "error" as const,
  }));
  return { ok: false, diagnostics };
}

/**
 * Assemble a NEW envelope object with keys in the canonical serialization order,
 * from the validated (defaults-applied) domain. Building a fresh object — rather
 * than spreading the untrusted input — is both the deterministic-order mechanism
 * (Pitfall 3) and the T-17-01 mitigation (no untrusted key ever reaches a
 * prototype-affecting sink).
 */
function orderDomain(d: SpecDomain) {
  return {
    key: d.key,
    owner: d.owner ?? null,
    specVersion: d.specVersion,
    updated: d.updated,
    // CHRT-003: carry `scope` in the SAME canonical position it holds in the
    // schema (after `updated`, before `requirements`). Without this line the
    // whitelist rebuild silently strips an authored charter on every write —
    // the em-dash-silent-zero failure mode. `?? null` normalizes an absent
    // charter to an explicit null (mirroring `owner`), so an unscoped domain
    // re-reads as `scope === null`, never `undefined`.
    scope: d.scope ?? null,
    requirements: d.requirements.map((r) => ({
      id: r.id,
      status: r.status,
      statement: r.statement,
      why: r.why ?? null,
      supersedes: r.supersedes ?? null,
      supersededBy: r.supersededBy ?? null,
      relates: r.relates,
      livesIn: r.livesIn,
      issues: r.issues.map((iss) => ({ role: iss.role, id: iss.id })),
      // IN-01: `changedAtVersion` is part of the STOR-01 requirement shape and
      // is accepted by SpecRequirementSchema, but the whitelist previously
      // dropped it — so the value the authoring commands set never reached disk
      // and the field looked silently ignored. Preserve it in its canonical
      // (last) position so the contract is legible and the field round-trips.
      // `undefined` (a requirement that never set it) is omitted by
      // JSON.stringify, so requirements without it stay byte-identical.
      changedAtVersion: r.changedAtVersion,
      // Provenance of the lifecycle exit — carried alongside changedAtVersion so
      // a supersession/retirement version survives the whitelist rebuild.
      // `undefined` (never superseded, or pre-field history) omits by
      // JSON.stringify, so untouched requirements stay byte-identical.
      supersededAtVersion: r.supersededAtVersion,
      // TERM-01 (Phase 6): carry the four glossary-term fields in their
      // canonical (schema) positions. WITHOUT these lines the whitelist rebuild
      // silently strips an authored term/aliases/cites/section on every write —
      // the scope/IN-01 strip-trap, now bitten a THIRD time if omitted. `term`
      // is a plain optional (undefined omitted by JSON.stringify, so a non-term
      // requirement stays byte-identical); `aliases`/`cites` carry their `[]`
      // default exactly like `relates`/`livesIn`; `section` preserves an
      // explicit null and omits when absent (nullable + optional). `cites`
      // entries are re-projected key-by-key so no untrusted key rides along
      // (T-06-01, mirroring the `issues` map above).
      term: r.term,
      aliases: r.aliases,
      cites: r.cites.map((c) => ({ term: c.term, pinned: c.pinned })),
      section: r.section,
    })),
  };
}

/**
 * The single WRITE seam (VAL-01 / VAL-02). Validates `domain` through the SAME
 * `validateDomainFile` the index reader uses, then — only on success — serializes
 * with a fixed key order + exactly one trailing newline and writes to `path`.
 *
 * On validation failure it writes NOTHING and returns the reject Diagnostic[]
 * (the discriminated-union contract callers in 17-04/17-05 branch on — print the
 * diagnostics + exit non-zero rather than throw). Because the rejection comes
 * straight from `validateDomainFile`, the write-path diagnostic is byte-identical
 * to the index-path diagnostic for the same object (VAL-02).
 *
 * Uses `Bun.write` (a global) — it does NOT trip the D-11 bun:sqlite import fence.
 *
 * @spec SCHM-004
 */
export async function validateAndWrite(
  path: string,
  domain: unknown,
  sourceFile?: string,
): Promise<{ ok: true } | { ok: false; diagnostics: Diagnostic[] }> {
  const validated = validateDomainFile(domain, sourceFile ?? path);
  if (!validated.ok) {
    return { ok: false, diagnostics: validated.diagnostics };
  }
  const serialized = `${JSON.stringify(orderDomain(validated.data), null, 2)}\n`;
  await Bun.write(path, serialized);
  return { ok: true };
}
