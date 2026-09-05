// packages/engine/src/operations/reads.ts
//
// The read operations. Each takes an open Storage handle (the surface owns the
// handle: the CLI and MCP open one per call through withIndex, the HTTP API
// keeps one for its lifetime) and returns plain data. Input shape validation
// belongs to the surface that parsed the input; an operation only fails for
// reasons the engine determines.

import { buildCoverageReport, type FtsHit, type Storage } from "@spec-engine/shared";
import type { ReqTagRow } from "../resolve/format";
import { fail, type OpFailure } from "./_result";

const FTS_SYNTAX_ERROR_PREFIX = "searchFts: FTS5 query syntax error";

export interface QueryResult {
  ok: true;
  hits: FtsHit[];
  /** True when the platform holds no requirements at all (first-spec guidance, not "no match"). */
  platformEmpty: boolean;
}

/** Full-text retrieval. Fails with `usage` on an FTS5 grammar error. */
// @spec SCHM-012
export function query(storage: Storage, text: string, limit: number): QueryResult | OpFailure {
  let hits: FtsHit[];
  try {
    hits = storage.searchFts(text, limit);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith(FTS_SYNTAX_ERROR_PREFIX)) {
      return fail("usage", "FTS5 query syntax error — try wrapping the phrase in double quotes");
    }
    throw e;
  }
  return {
    ok: true,
    hits,
    platformEmpty: hits.length === 0 && storage.listRequirements().length === 0,
  };
}

/** Requirements tagged in the given platform-relative files. */
// @spec SCHM-012
export function resolveFiles(storage: Storage, files: string[]) {
  const rows = storage.resolveByFiles(files);
  return {
    ok: true as const,
    rows,
    platformEmpty: rows.length === 0 && storage.listRequirements().length === 0,
  };
}

/** Project a stored tag onto the surface row: the AUTOINCREMENT id is an index
 *  detail, and a missing level is null, never undefined. */
export function toReqTagRows(tags: ReturnType<Storage["listTags"]>): ReqTagRow[] {
  return tags.map(({ req_id, repo, file, line, kind, level }) => ({
    req_id,
    repo,
    file,
    line,
    kind: kind as string,
    level: (level ?? null) as string | null,
  }));
}

export interface ReqTagsResult {
  ok: true;
  rows: ReqTagRow[];
  /** Whether the requirement exists in the index (an unknown id still answers `[]`). */
  known: boolean;
}

/** Every tag site for one requirement across all repos. */
// @spec SCHM-012
export function reqTags(storage: Storage, reqId: string): ReqTagsResult {
  const rows = toReqTagRows(storage.listTags({ req_id: reqId }));
  return { ok: true, rows, known: storage.getRequirement(reqId) !== null };
}

/** Per-member migration state for a superseded requirement. */
// @spec SCHM-012
export function propagation(storage: Storage, reqId: string) {
  const rows = storage.propagationFor(reqId);
  return {
    ok: true as const,
    rows,
    platformEmpty: rows.length === 0 && storage.listRequirements().length === 0,
  };
}

/** Per-domain coverage rollup over Active requirements. */
// @spec SCHM-012
export function coverageReport(storage: Storage) {
  return { ok: true as const, rows: buildCoverageReport(storage.coverageMatrix()) };
}

/** The requirement-by-repo coverage matrix, unsorted; the renderer owns the order. */
// @spec SCHM-012
export function coverageMatrix(storage: Storage) {
  return { ok: true as const, rows: storage.coverageMatrix() };
}

/** Every `relates` link, unsorted; the renderer owns the order. */
// @spec SCHM-012
export function relations(storage: Storage) {
  return { ok: true as const, rows: storage.listRelations() };
}

/**
 * The provenance matrix, or the rows linked to one opaque issue id when given.
 * The issue id is a bound filter value, never a key.
 */
// @spec SCHM-012
export function provenance(storage: Storage, issueId?: string) {
  const rows = issueId ? storage.provenanceByIssue(issueId) : storage.provenanceMatrix();
  return { ok: true as const, rows };
}
