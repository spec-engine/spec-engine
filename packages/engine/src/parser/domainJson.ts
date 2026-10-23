// @spec INDX-016
//
// Pure: no DB driver import and no `Bun.file`. The pipeline owns the file read.

import {
  type Diagnostic,
  type ProvenanceRow,
  parseDomainText,
  type RelationRow,
  type Requirement,
  type RequirementStatus,
  type SpecDomain,
  type TermAliasRow,
} from "@spec-engine/shared";
import { findRequirementIdLine } from "./requirementLine";
import type { ParsedSpec, RawTermCitation } from "./types";

// A status outside this map casts through the RequirementStatus seam verbatim
// so BAD_STATUS lands downstream. The union itself is never widened here.
const STATUS_CASE_MAP: Readonly<Record<string, RequirementStatus>> = Object.freeze({
  active: "Active",
  draft: "Draft",
  superseded: "Superseded",
  deprecated: "Deprecated",
  // Legacy alias (pre-rename files): reads as Deprecated; new writes use
  // "deprecated". The word is deprecated everywhere a human reads it.
  retired: "Deprecated",
});

const VALID_ROLES: ReadonlySet<string> = new Set(["created", "supersedes-via", "amends-via"]);

export interface ParseDomainJsonFileOptions {
  /** Also scanned for the literal `"id": "<id>"` line to derive `line`. */
  text: string;
  /** Platform-relative, never absolute: copied into each row's source_file. */
  sourceFile: string;
  fallbackKey: string;
}

/** `data` has already been validated by the caller. */
export interface ParseDomainJsonOptions {
  data: SpecDomain;
  text: string;
  sourceFile: string;
  fallbackKey: string;
}

export type ParseDomainJsonResult =
  | { ok: true; spec: ParsedSpec }
  | { ok: false; diagnostics: Diagnostic[] };

export function parseDomainJsonFile(opts: ParseDomainJsonFileOptions): ParseDomainJsonResult {
  const validated = parseDomainText(opts.text, opts.sourceFile);
  if (!validated.ok) {
    return { ok: false, diagnostics: validated.diagnostics };
  }

  return { ok: true, spec: parseDomainJson({ data: validated.data, ...opts }) };
}

// Validation has applied defaults, so `relates`/`issues` are always arrays.
type DomainRequirement = SpecDomain["requirements"][number];

/** `authoredChangedAtVersion` is honored only for key='TERM' (see
 *  `assignChangedAtVersion`). */
interface Working {
  req: Requirement;
  isSuperseded: boolean;
  authoredChangedAtVersion: number | undefined;
}

interface RelatesAcc {
  relations: RelationRow[];
  seenRelates: Set<string>;
  selfRelates: ParsedSpec["self_relates"];
  seenSelfRelates: Set<string>;
}

interface IssuesAcc {
  provenance: ProvenanceRow[];
  seenProv: Set<string>;
  unknownRoles: ParsedSpec["unknown_roles"];
}

interface TermAcc {
  aliases: TermAliasRow[];
  seenAliases: Set<string>;
  citations: RawTermCitation[];
  seenCitations: Set<string>;
}

/** The one mapping from a validated domain to `ParsedSpec`. The pipeline and
 *  `parseDomainJsonFile` both call it, so the read path cannot fork. */
export function parseDomainJson(opts: ParseDomainJsonOptions): ParsedSpec {
  const { data, text, sourceFile, fallbackKey } = opts;

  const key = data.key.length > 0 ? data.key : fallbackKey;
  const owner = data.owner ?? null;
  // The JSON envelope carries no `schema`.
  const schema: string | null = null;
  // Derived from the supersede DAG; the authored envelope `specVersion` is
  // ignored, so the number cannot lie because no human writes it.
  const spec_version = deriveDomainVersion(data.requirements);
  const updated: string | null = data.updated ?? null;

  // Split the RAW text once; each requirement's line is located by
  // `findRequirementIdLine` under a cursor that only moves forward.
  const rawLines = text.split("\n");
  let lineCursor = 0;

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
    const found = findRequirementIdLine(rawLines, r.id, lineCursor);
    // An absent id still needs a stable positive integer: build_id hashes `line`.
    const line = found >= 0 ? found + 1 : idx + 1;
    if (found >= 0) lineCursor = found + 1;
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
    term_aliases: termAcc.aliases,
    term_citations: termAcc.citations,
  };
}

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
  return { req, isSuperseded, authoredChangedAtVersion: r.changedAtVersion };
}

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

/** A well-formed issue_id is opaque: the requirement-id pattern is never
 *  applied, so a KEY-NNN-shaped value stores verbatim. */
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
 * One row per headword and per alias, so a citation by name resolves against
 * either.
 * @spec INDX-026
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
 * `term_id` is not resolved here: a citation may name a term defined in
 * another domain, so the pipeline resolves it across the whole platform.
 * @spec INDX-026
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
 * Each superseded requirement is one supersession, so the version is
 * `1 + count`: monotonic, with no authored counter. A cross-domain `spec move`
 * counts in the source domain, wherever the successor lives.
 */
export function deriveDomainVersion(
  requirements: readonly { supersededBy?: string | null | undefined }[],
): number {
  // @spec SCHM-018
  // @spec SCHM-019
  let edges = 0;
  for (const r of requirements) {
    if ((r.supersededBy ?? null) !== null) edges++;
  }
  return 1 + edges;
}

/**
 * A non-superseded TERM honors its authored `changedAtVersion`, so a
 * `spec term revise` bump drifts older citation pins. The exception is scoped
 * to the TERM domain so every other domain's `changed_at_version`, and with it
 * build_id, stays unchanged.
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
      w.req.changed_at_version = w.authoredChangedAtVersion ?? 1;
    } else {
      w.req.changed_at_version = 1;
    }
  }
}
