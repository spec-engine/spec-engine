// packages/engine/src/operations/records.ts
//
// Full requirement records from the derived index: one by id, or every
// record in (key, seq) order with optional domain and status filters. Unlike
// `query`, these include superseded and deprecated rows and never rank.

import {
  REQUIREMENT_STATUSES,
  type Requirement,
  type RequirementStatus,
  type Storage,
} from "@spec-engine/shared";

export interface GetRecordResult {
  ok: true;
  /** Null when the id is not in the index. */
  row: Requirement | null;
  /** True when the platform holds no requirements at all (first-spec guidance, not "unknown id"). */
  platformEmpty: boolean;
}

/** One requirement's full record. */
// @spec MAP-003
// @spec SCHM-012
export function getRecord(storage: Storage, id: string): GetRecordResult {
  const row = storage.getRequirement(id);
  return {
    ok: true,
    row,
    platformEmpty: row === null && storage.listRequirements().length === 0,
  };
}

export interface ListRecordsFilter {
  /** A normalized domain key. */
  key?: string | undefined;
  status?: RequirementStatus | undefined;
}

export interface ListRecordsResult {
  ok: true;
  /** In (key, seq) order, as the index stores them. */
  rows: Requirement[];
  platformEmpty: boolean;
}

/** Every requirement record, optionally filtered. */
// @spec MAP-004
// @spec SCHM-012
export function listRecords(storage: Storage, filter: ListRecordsFilter = {}): ListRecordsResult {
  const rows = storage.listRequirements(filter);
  return {
    ok: true,
    rows,
    platformEmpty: rows.length === 0 && storage.listRequirements().length === 0,
  };
}

/** The status words a surface offers, in lifecycle order; each resolves through `requirementStatus`. */
export const STATUS_WORDS = ["active", "draft", "superseded", "deprecated"] as const;

/**
 * The stored status a caller's word names, case-insensitively (`active` and
 * `Active` both resolve), or null when it names none. A surface uses this to
 * word its own refusal.
 */
export function requirementStatus(raw: string): RequirementStatus | null {
  const lc = raw.trim().toLowerCase();
  return REQUIREMENT_STATUSES.find((s) => s.toLowerCase() === lc) ?? null;
}
