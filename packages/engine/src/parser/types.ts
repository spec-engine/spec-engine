// packages/engine/src/parser/types.ts
//
// Format-agnostic parser output shape. `ParsedSpec` is the internal record
// the JSON domain-file reader (domainJson.ts) produces and the
// indexer/diagnostics pipeline consumes. It was relocated VERBATIM here in
// 18-04 — no field or shape changes — ahead of the Phase 18 hard cutover
// (18-05) that deleted the Markdown parse path, so its non-Markdown members
// (domainJson.ts, indexer/diagnostics.ts) survive that removal untouched.

import type { ProvenanceRow, RelationRow, Requirement, TermAliasRow } from "@spec-engine/shared";

// --- Raw citation (pre-resolution) ------------------------------------------

/** TERM-03 (Phase 6, Wave C): a RAW citation flattened from a requirement's
 *  `cites[]` field, BEFORE cross-spec `term_id` resolution. `cited_as` is the
 *  authored surface form — a TERM id OR an exact term name/alias. The pipeline
 *  resolves it to a `term_id` (or null) via the AGGREGATE `term_aliases`
 *  name→id map + the reserved TERM id set, producing the final
 *  `TermCitationRow`. It stays raw here because a citation may name a TERM
 *  defined in a DIFFERENT spec, so resolution needs the whole platform's terms,
 *  not one spec's — mirroring how relates targets are diagnosed at check time,
 *  never resolved at parse time (Invariant #4). */
export interface RawTermCitation {
  req_id: string;
  cited_as: string;
  pinned_version: number | null;
  source_file: string;
  line: number;
}

// --- Spec file --------------------------------------------------------------

export interface ParsedSpec {
  key: string;
  owner: string | null;
  schema: string | null;
  spec_version: number;
  updated: string | null;
  requirements: Requirement[];
  /** RED-16: one entry per `**Relates:**` link, in authored order.
   *  Self-references and per-requirement duplicates are dropped here;
   *  broken targets are kept (diagnosed at check time, never blocked at
   *  parse time — Invariant #4). */
  relations: RelationRow[];
  /** T5: Relates tokens that named their own requirement — dropped from
   *  `relations` but surfaced (one entry per requirement, first occurrence
   *  wins) so validateStructure can emit SELF_RELATES instead of the drop
   *  being silent. */
  self_relates: { req_id: string; source_file: string; line: number }[];
  /** PROV-01/03: one entry per well-formed `**Issues:** role:ID` token, in
   *  authored order. Roles are validated against the closed allow-list
   *  {created, supersedes-via, amends-via}; per-(req,role,issue) duplicates
   *  are dropped here. issue_id is OPAQUE — ID_RE is NEVER applied to it
   *  (PROV-02/SC3). Unknown-role / colon-less tokens are NOT here — they are
   *  surfaced in `unknown_roles` and never stored (PROV-05). */
  provenance: ProvenanceRow[];
  /** PROV-05: `**Issues:**` tokens whose role is outside the allow-list, or
   *  which have no recognizable `role:ID` colon shape. Surfaced (in authored
   *  order) so validateStructure can emit UNKNOWN_ROLE; these tokens are
   *  DROPPED from `provenance` — never silently stored. `issue_id` is the
   *  substring after the first colon, or null for a colon-less token. */
  unknown_roles: {
    req_id: string;
    role: string;
    issue_id: string | null;
    source_file: string;
    line: number;
  }[];
  /** TERM-01 (Phase 6): one row per glossary-term alias — the requirement's
   *  `term` (canonical headword) AND each `aliases` entry flattened to
   *  `{ term_id, name }`. Wave C (TERM-03) populates it; the pipeline aggregates
   *  these across all specs into the name→term_id map that resolves
   *  citation-by-name. */
  term_aliases: TermAliasRow[];
  /** TERM-03 (Phase 6, Wave C): one RAW citation per `cites[]` entry, BEFORE
   *  `term_id` resolution (see `RawTermCitation`). The pipeline resolves each
   *  `cited_as` to a `term_id` (or null) and writes the final `TermCitationRow`
   *  — resolution is a platform-wide concern, so it cannot happen here. */
  term_citations: RawTermCitation[];
}
