// packages/engine/src/parser/domainJson.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec SCHM-003
//
// POC-014: SPEC.json is the authoring/interchange format the engine ingests.
// Re-homed here from the deleted `parser/spec.ts` in the Phase 18 hard
// cutover (D2) — this JSON reader is now the SOLE domain-file format the
// engine reads.
//
// STOR-01/STOR-02 (17-02): the JSON domain-file reader. Maps a `SPEC.json`
// domain envelope `{ key, owner, specVersion, updated, requirements[] }` to the
// UNCHANGED internal row shapes (`Requirement` / `RelationRow` / `ProvenanceRow`).
// Post-cutover (Phase 18, D2) this is the ONLY spec read path — the Markdown
// parser is deleted — so `computeBuildId`, the coverage VIEW, and every
// Phase 3-16 member read exclusively from JSON-sourced rows.
//
// Design notes:
//   1. ONE structural validator (VAL-02): this reader delegates ALL structural
//      validation to `validateDomainFile` from `@spec-engine/shared` (shipped by 17-01).
//      There is NO second validator here — a structurally-invalid file returns the
//      SAME INVALID_DOMAIN_FILE diagnostics the write path emits.
//   2. TWO-TIER (Invariant #4): `status` and `issues[].role` are free strings at
//      the structural tier. A lowercase JSON status is case-mapped to the internal
//      Capitalized `RequirementStatus`; an UNKNOWN status casts through the seam
//      verbatim (mirroring spec.ts:239-240) so `validateStructure` emits BAD_STATUS
//      downstream. The `RequirementStatus` union is UNCHANGED.
//   3. DETERMINISTIC line (T-17-02, Pitfall 4): `JSON.parse` discards source
//      positions, so the reader derives `line` from the RAW text via a LITERAL
//      substring search for `"id": "<id>"` — NEVER a dynamically-built RegExp
//      (the T-17-02 ReDoS mitigation). build_id hashes `line`, so it must be stable.
//   4. PURITY: no DB driver import, no `Bun.file` — this module transforms text →
//      ParsedSpec. The pipeline owns the file read (mirrors spec.ts's purity note
//      and the D-08 grep-fence, which forbids the sqlite driver import here).
//   5. STOR-03: a non-JSON body or a structural reject returns a discriminated
//      `{ ok: false; diagnostics }` — the em-dash silent-zero is gone; the caller
//      surfaces the diagnostics LOUDLY and the file contributes ZERO requirements.

import {
  type Diagnostic,
  DiagnosticCode,
  type ProvenanceRow,
  type RelationRow,
  type Requirement,
  type RequirementStatus,
  type SpecDomain,
  type TermAliasRow,
  validateDomainFile,
} from "@spec-engine/shared";
import type { ParsedSpec, RawTermCitation } from "./types";

// Lowercase authored JSON status → internal Capitalized RequirementStatus. A
// status outside this map is an unknown/planted defect: it casts through the
// RequirementStatus seam verbatim so BAD_STATUS lands (Invariant #4). The union
// itself is never widened here.
const STATUS_CASE_MAP: Readonly<Record<string, RequirementStatus>> = Object.freeze({
  active: "Active",
  draft: "Draft",
  superseded: "Superseded",
  retired: "Retired",
});

// PROV-01/05: closed allow-list of provenance roles — identical contract to
// parser/spec.ts VALID_ROLES. A role outside this set (or an empty issue id)
// is surfaced as UNKNOWN_ROLE and never stored.
const VALID_ROLES: ReadonlySet<string> = new Set(["created", "supersedes-via", "amends-via"]);

export interface ParseDomainJsonFileOptions {
  /** RAW file text — the reader `JSON.parse`s it AND scans it for the literal
   *  `"id": "<id>"` line to derive a deterministic `line`. */
  text: string;
  /** Platform-relative path to the SPEC.json (e.g. "spec-engine/BILLING/SPEC.json")
   *  — copied verbatim into each emitted row's source_file. NEVER absolute (T-17-04). */
  sourceFile: string;
  /** Fallback domain key when the envelope `key` is absent (schema requires it,
   *  so this is defensive). */
  fallbackKey: string;
}

/** Options for the PURE mapper `parseDomainJson` — the validated domain plus the
 *  raw text (needed for the deterministic `line` scan) and the platform-relative
 *  source path. The caller (index pipeline) has already run `validateDomainFile`. */
export interface ParseDomainJsonOptions {
  data: SpecDomain;
  text: string;
  sourceFile: string;
  fallbackKey: string;
}

export type ParseDomainJsonResult =
  | { ok: true; spec: ParsedSpec }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Read a JSON domain file into a `ParsedSpec` (STOR-01/STOR-02).
 *
 * Steps:
 *   1. `JSON.parse(text)` inside try/catch — on throw the body is not JSON, so
 *      return one INVALID_DOMAIN_FILE diagnostic (STOR-03) — never throw.
 *   2. `validateDomainFile(parsed, sourceFile)` — the ONE structural gate (VAL-02).
 *      On failure return its diagnostics verbatim (byte-identical to the write path).
 *   3. Map the validated, defaults-applied `SpecDomain` → `ParsedSpec`.
 */
export function parseDomainJsonFile(opts: ParseDomainJsonFileOptions): ParseDomainJsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      diagnostics: [
        {
          code: DiagnosticCode.INVALID_DOMAIN_FILE,
          source_file: opts.sourceFile,
          // WR-02: storage-normalized `line` (0, not null) — mirrors
          // validateDomainFile so every INVALID_DOMAIN_FILE the reader emits
          // (parse failure OR structural reject) carries the SAME `line` shape
          // the storage row (ParseDiagnostic.line: number) expects.
          line: 0,
          repo: null,
          req_id: null,
          detail: `not valid JSON: ${msg}`,
          severity: "error",
        },
      ],
    };
  }

  const validated = validateDomainFile(parsed, opts.sourceFile);
  if (!validated.ok) {
    return { ok: false, diagnostics: validated.diagnostics };
  }

  return { ok: true, spec: parseDomainJson({ data: validated.data, ...opts }) };
}

// The validated domain's requirement element — the structural gate
// (`validateDomainFile`) has already applied defaults, so `relates`/`issues`
// are present arrays and `id`/`status`/`statement` are populated strings.
type DomainRequirement = SpecDomain["requirements"][number];

/** One mapped requirement plus the derived supersede flag the second
 *  `changed_at_version` pass consumes. `authoredChangedAtVersion` carries the
 *  entry's own `changedAtVersion` field (TERM-05): the second pass honors it for
 *  key='TERM' so an in-place `spec term revise` version-bump makes the term drift
 *  against older citation pins (non-TERM derivation is UNCHANGED). */
interface Working {
  req: Requirement;
  isSuperseded: boolean;
  authoredChangedAtVersion: number | undefined;
}

/** Relates accumulators (RED-16 parity): authored-order rows, self-refs
 *  surfaced separately, plus the per-file dedupe Sets (one entry per (from,to)). */
interface RelatesAcc {
  relations: RelationRow[];
  seenRelates: Set<string>;
  selfRelates: ParsedSpec["self_relates"];
  seenSelfRelates: Set<string>;
}

/** Issues accumulators (PROV-01/02/05 parity): authored-order provenance rows,
 *  the per-file dedupe Set, and the surfaced unknown-role rows. */
interface IssuesAcc {
  provenance: ProvenanceRow[];
  seenProv: Set<string>;
  unknownRoles: ParsedSpec["unknown_roles"];
}

/** Term-store accumulators (TERM-03, Wave C — flattenRelates/flattenIssues
 *  parity): authored-order alias rows (canonical name + each alias) and RAW
 *  citation rows (pre-resolution), each with its own per-file dedupe Set. */
interface TermAcc {
  aliases: TermAliasRow[];
  seenAliases: Set<string>;
  citations: RawTermCitation[];
  seenCitations: Set<string>;
}

/**
 * Map an ALREADY-VALIDATED `SpecDomain` → `ParsedSpec`: internal row
 * construction, relates/issues flatten, and the `changed_at_version` second
 * pass. (This mapping was the Markdown parser's job before the Phase 18 hard
 * cutover deleted that path — the JSON reader is now the sole producer.)
 *
 * This is the pure mapper. The index pipeline calls `validateDomainFile` for the
 * structural gate (VAL-02) and then this function on success; the convenience
 * wrapper `parseDomainJsonFile` above does parse + validate + map for standalone
 * callers (e.g. the reader unit test). Both share this ONE mapping so the read
 * path cannot fork. The heavy per-requirement work is split into named helpers
 * (`deriveRequirementLine`, `mapRequirementRow`, `flattenRelates`,
 * `flattenIssues`, `assignChangedAtVersion`) — this driver just wires them.
 */
export function parseDomainJson(opts: ParseDomainJsonOptions): ParsedSpec {
  const { data, text, sourceFile, fallbackKey } = opts;

  const key = data.key.length > 0 ? data.key : fallbackKey;
  const owner = data.owner ?? null;
  // STOR-02 omits `schema` from the JSON envelope — the Markdown parser derives
  // it from frontmatter; the JSON reader emits null (no schema column drift).
  const schema: string | null = null;
  // SCHM-006 / SCHM-007: the domain version is DERIVED from the supersede DAG,
  // never read from the authored envelope `specVersion` (retired as a source of
  // truth). Every `supersededBy` edge is exactly one lifecycle step, so
  // `1 + edgeCount` reproduces the "counter advances once per supersede"
  // contract as a pure, monotonic projection over the requirements — the stable
  // anchor member pins / drift / gate resolve against. Authored `specVersion`
  // on the envelope (and any authored `changedAtVersion` on non-TERM entries)
  // is IGNORED here; the number cannot lie because no human writes it.
  const spec_version = deriveDomainVersion(data.requirements);
  const updated: string | null = data.updated ?? null;

  // Deterministic `line` derivation (T-17-02): split the RAW text once; each
  // requirement's line is located by `deriveRequirementLine`.
  const rawLines = text.split("\n");

  const working: Working[] = [];
  const relatesAcc: RelatesAcc = {
    relations: [],
    seenRelates: new Set<string>(),
    selfRelates: [],
    seenSelfRelates: new Set<string>(),
  };
  const issuesAcc: IssuesAcc = {
    provenance: [],
    seenProv: new Set<string>(),
    unknownRoles: [],
  };
  const termAcc: TermAcc = {
    aliases: [],
    seenAliases: new Set<string>(),
    citations: [],
    seenCitations: new Set<string>(),
  };

  for (let idx = 0; idx < data.requirements.length; idx++) {
    const r = data.requirements[idx] as DomainRequirement;
    const line = deriveRequirementLine(rawLines, r.id, idx);
    working.push(mapRequirementRow(r, key, sourceFile, spec_version, line));
    flattenRelates(r, sourceFile, line, relatesAcc);
    flattenIssues(r, sourceFile, line, issuesAcc);
    // Only TERM-domain entries contribute to the name→term_id resolution map.
    // The schema allows an optional `aliases` on ANY requirement, so a stray
    // `aliases`/`term` on a non-TERM req must NOT pollute term resolution — a
    // non-TERM id (lexically < "TERM") would otherwise hijack a colliding term
    // name under first-wins-by-sort and fire a spurious gating UNDEFINED_TERM
    // against innocent citing requirements. Gate on the domain key, not on the
    // field being empty (which the schema does not enforce).
    if (key === "TERM") flattenAliases(r, termAcc);
    flattenCites(r, sourceFile, line, termAcc);
  }

  assignChangedAtVersion(working, spec_version);

  return {
    key,
    owner,
    schema,
    spec_version,
    updated,
    requirements: working.map((w) => w.req),
    relations: relatesAcc.relations,
    self_relates: relatesAcc.selfRelates,
    provenance: issuesAcc.provenance,
    unknown_roles: issuesAcc.unknownRoles,
    // TERM-03 (Phase 6, Wave C): the `term`/`aliases` flatten (term_aliases) and
    // the RAW `cites` flatten (term_citations, pre-resolution). The pipeline
    // aggregates the aliases into a name→term_id map and resolves each raw
    // citation's `cited_as` to a term_id (or null) across the whole platform.
    term_aliases: termAcc.aliases,
    term_citations: termAcc.citations,
  };
}

/**
 * Deterministic `line` derivation (T-17-02, Pitfall 4): `JSON.parse` discards
 * source positions, so locate each requirement's `"id": "<id>"` via a LITERAL
 * substring search — NEVER a dynamically-built RegExp (the T-17-02 ReDoS
 * mitigation). `findIndex` returns -1 when absent (e.g. an id not on its own
 * `"id"` line); fall back to a fixed value so `line` stays a stable,
 * deterministic positive integer (build_id hashes it).
 */
function deriveRequirementLine(rawLines: string[], id: string, idx: number): number {
  const needle = `"id": "${id}"`;
  const found = rawLines.findIndex((l) => l.includes(needle));
  return found >= 0 ? found + 1 : idx + 1;
}

/**
 * Build one internal `Requirement` row from a validated domain requirement.
 * TWO-TIER (Invariant #4): case-map the lowercase JSON status to the internal
 * Capitalized `RequirementStatus`; an UNKNOWN status casts through the seam
 * verbatim (spec.ts:239-240 parity) so `validateStructure` emits BAD_STATUS
 * downstream. `changed_at_version` is a placeholder patched by the second pass.
 */
function mapRequirementRow(
  r: DomainRequirement,
  key: string,
  sourceFile: string,
  spec_version: number,
  line: number,
): Working {
  const id = r.id;
  const seq = Number(id.split("-")[1]);

  const mapped = STATUS_CASE_MAP[r.status.toLowerCase()];
  const status: RequirementStatus = mapped ?? (r.status as RequirementStatus);
  const isSuperseded = mapped === "Superseded";

  const req: Requirement = {
    id,
    key,
    seq,
    status,
    superseded_by: r.supersededBy ?? null,
    text: r.statement,
    why: r.why ?? null,
    source_file: sourceFile,
    line,
    spec_version,
    // Placeholder — patched in the second pass (assignChangedAtVersion).
    changed_at_version: 1,
    // Authored once at supersession, never recomputed — carried through verbatim.
    superseded_at_version: r.supersededAtVersion ?? null,
  };
  // TERM-05: retain the entry's authored `changedAtVersion` for the second pass
  // to honor (key='TERM' only). `undefined` for a requirement that never set it.
  return { req, isSuperseded, authoredChangedAtVersion: r.changedAtVersion };
}

/**
 * Flatten `relates[]` → RelationRow (RED-16): authored order, self-references
 * surfaced into `self_relates` (first occurrence wins) instead of stored, and
 * per-(from,to) duplicates deduped across the file.
 */
function flattenRelates(
  r: DomainRequirement,
  sourceFile: string,
  line: number,
  acc: RelatesAcc,
): void {
  const id = r.id;
  for (const to of r.relates) {
    const t = to.trim();
    if (!t) continue;
    if (t === id) {
      if (!acc.seenSelfRelates.has(t)) {
        acc.seenSelfRelates.add(t);
        acc.selfRelates.push({ req_id: id, source_file: sourceFile, line });
      }
      continue;
    }
    const dedupeKey = `${id}\x00${t}`;
    if (acc.seenRelates.has(dedupeKey)) continue;
    acc.seenRelates.add(dedupeKey);
    acc.relations.push({ from_id: id, to_id: t, source_file: sourceFile, line });
  }
}

/**
 * Flatten `issues[]` → ProvenanceRow (PROV-01/02/05). A role outside the
 * VALID_ROLES allow-list, or an empty issue id, is surfaced as UNKNOWN_ROLE and
 * DROPPED (PROV-05, spec.ts:334-343 parity) — never silently stored. A
 * well-formed issue_id is OPAQUE — ID_RE is NEVER applied, so a KEY-NNN-shaped
 * value stores verbatim (PROV-02) — and per-(req,role,issue) duplicates dedupe.
 */
function flattenIssues(
  r: DomainRequirement,
  sourceFile: string,
  line: number,
  acc: IssuesAcc,
): void {
  const id = r.id;
  for (const iss of r.issues) {
    const role = iss.role;
    const issue_id = iss.id;
    if (!VALID_ROLES.has(role) || issue_id.length === 0) {
      acc.unknownRoles.push({
        req_id: id,
        role,
        issue_id: issue_id.length === 0 ? null : issue_id,
        source_file: sourceFile,
        line,
      });
      continue;
    }
    const dedupeKey = `${id}\x00${role}\x00${issue_id}`;
    if (acc.seenProv.has(dedupeKey)) continue;
    acc.seenProv.add(dedupeKey);
    acc.provenance.push({ req_id: id, issue_id, role, source_file: sourceFile, line });
  }
}

/**
 * Flatten a requirement's `term` + `aliases` → TermAliasRow (TERM-03,
 * flattenRelates parity). Only a TERM entry carries these fields; a
 * non-term requirement has `term` undefined and `aliases` empty, so nothing is
 * pushed. One row per canonical `term` name AND one per alias (so a
 * citation-by-name resolves against EITHER the headword or a synonym); blanks
 * are skipped and per-(term_id,name) duplicates deduped. `term_id` is the
 * owning requirement's own id — a term IS a requirement (FORK 1).
 * @spec INDX-005
 */
function flattenAliases(r: DomainRequirement, acc: TermAcc): void {
  const id = r.id;
  const names: string[] = [];
  const canonical = r.term?.trim() ?? "";
  if (canonical) names.push(canonical);
  for (const a of r.aliases) {
    const name = a.trim();
    if (name) names.push(name);
  }
  for (const name of names) {
    const dedupeKey = `${id}\x00${name}`;
    if (acc.seenAliases.has(dedupeKey)) continue;
    acc.seenAliases.add(dedupeKey);
    acc.aliases.push({ term_id: id, name });
  }
}

/**
 * Flatten a requirement's `cites[]` → RawTermCitation (TERM-03, flattenRelates
 * parity). One RAW row per `{ term, pinned }` entry: `cited_as` is the authored
 * surface form (a TERM id OR an exact term name/alias — the pipeline resolves it
 * later), `pinned_version` the pinned TERM spec_version. Blank `term` values are
 * skipped and per-(req,cited_as) duplicates deduped. `term_id` is NOT resolved
 * here — a citation may name a term defined in another spec, so resolution is a
 * platform-wide pipeline step (Invariant #4: an unresolvable cite still lands).
 * @spec INDX-005
 */
function flattenCites(r: DomainRequirement, sourceFile: string, line: number, acc: TermAcc): void {
  const id = r.id;
  for (const c of r.cites) {
    const cited = c.term.trim();
    if (!cited) continue;
    const dedupeKey = `${id}\x00${cited}`;
    if (acc.seenCitations.has(dedupeKey)) continue;
    acc.seenCitations.add(dedupeKey);
    acc.citations.push({
      req_id: id,
      cited_as: cited,
      pinned_version: c.pinned,
      source_file: sourceFile,
      line,
    });
  }
}

/**
 * SCHM-006 / SCHM-007: derive the domain version from the supersede DAG. Each
 * requirement carrying a `supersededBy` link is one supersession event, so the
 * domain version is `1 + (number of superseded requirements)` — the initial
 * state is version 1 and every supersede advances it by exactly one. This is a
 * pure projection over the requirement list (no authored counter, no event
 * timestamps): it only ever increases as requirements supersede, giving pins /
 * drift / gate a stable, monotonic anchor. A cross-domain `spec move` counts in
 * the SOURCE domain (its requirement died here) regardless of where the
 * successor id lives — the count is over this domain's own edges.
 */
export function deriveDomainVersion(
  requirements: readonly { supersededBy?: string | null }[],
): number {
  // @spec SCHM-006
  // @spec SCHM-007
  let edges = 0;
  for (const r of requirements) {
    if ((r.supersededBy ?? null) !== null) edges++;
  }
  return 1 + edges;
}

/**
 * Second pass — assign `changed_at_version` (spec.ts:362-384 parity). A
 * superseded requirement — and the requirement it points to via `superseded_by`
 * — changed at `spec_version`; everything else stays at 1.
 *
 * TERM-05 exception (SCOPED to key='TERM' ONLY): a non-superseded glossary TERM
 * honors its AUTHORED `changedAtVersion` (default 1) instead of the forced-1.
 * This is what makes an in-place `spec term revise` version-bump (which sets the
 * entry's `changedAtVersion` to the new specVersion) exceed an older citation's
 * pin, so the `term_drift` VIEW fires TERM_DRIFT (Wave E). The scope is
 * deliberately the reserved TERM domain: non-TERM `changed_at_version`
 * derivation is IDENTICAL to before, so the existing drift-view + build_id
 * cold-rebuild tests stay byte-identical (T-06-15 regression guard).
 */
function assignChangedAtVersion(working: Working[], spec_version: number): void {
  const supersededIds = new Set<string>();
  for (const w of working) {
    if (w.isSuperseded && w.req.superseded_by !== null) {
      supersededIds.add(w.req.superseded_by);
    }
  }
  for (const w of working) {
    if (w.isSuperseded) {
      w.req.changed_at_version = spec_version;
    } else if (supersededIds.has(w.req.id)) {
      w.req.changed_at_version = spec_version;
    } else if (w.req.key === "TERM") {
      // Honor the authored changedAtVersion for glossary terms (drift pin).
      w.req.changed_at_version = w.authoredChangedAtVersion ?? 1;
    } else {
      w.req.changed_at_version = 1;
    }
  }
}
