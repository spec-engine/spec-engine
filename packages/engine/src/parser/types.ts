import type { ProvenanceRow, RelationRow, Requirement, TermAliasRow } from "@spec-engine/shared";

/** A citation flattened from a requirement's `cites[]`, before `term_id`
 *  resolution. `cited_as` is the authored form: a TERM id or an exact term
 *  name or alias. It stays raw because a citation may name a term defined in
 *  another domain, so resolution needs the whole platform's terms. */
export interface RawTermCitation {
  req_id: string;
  cited_as: string;
  pinned_version: number | null;
  source_file: string;
  line: number;
}

export interface ParsedSpec {
  key: string;
  owner: string | null;
  schema: string | null;
  spec_version: number;
  updated: string | null;
  requirements: Requirement[];
  /** Self-references and per-requirement duplicates are dropped; broken
   *  targets are kept and diagnosed at check time. */
  relations: RelationRow[];
  /** Relates entries naming their own requirement, dropped from `relations`
   *  and kept here (first occurrence wins) so SELF_RELATES is not silent. */
  self_relates: { req_id: string; source_file: string; line: number }[];
  /** `issue_id` is opaque: the requirement-id pattern is never applied to it. */
  provenance: ProvenanceRow[];
  /** Issues with a role outside the allow-list or an empty id, dropped from
   *  `provenance`. `issue_id` is null for an empty id. */
  unknown_roles: {
    req_id: string;
    role: string;
    issue_id: string | null;
    source_file: string;
    line: number;
  }[];
  /** A TERM entry's headword and each alias, one row per name. */
  term_aliases: TermAliasRow[];
  term_citations: RawTermCitation[];
}
