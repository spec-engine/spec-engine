import {
  type ImplementingSite,
  REQUIREMENT_STATUSES,
  type Requirement,
  type RequirementRecord,
  type RequirementStatus,
  type Storage,
  type VerifyingSite,
} from "@spec-engine/shared";

export interface GetRecordResult {
  ok: true;
  /** Null when the id is not in the index. */
  row: RequirementRecord | null;
  /** True when the platform holds no requirements at all (first-spec guidance, not "unknown id"). */
  platformEmpty: boolean;
}

/** One requirement's full record and the code sites its tags name. */
// @spec MAP-006
// @spec MAP-005
// @spec SCHM-012
// @spec SCHM-040
export function getRecord(storage: Storage, id: string): GetRecordResult {
  const req = storage.getRequirement(id);
  if (req === null) {
    return { ok: true, row: null, platformEmpty: storage.listRequirements().length === 0 };
  }
  const implemented_in: ImplementingSite[] = [];
  const verified_in: VerifyingSite[] = [];
  for (const { repo, file, line, kind, level } of storage.listTags({ req_id: id })) {
    if (kind === "verifies") verified_in.push({ repo, file, line, level: level ?? null });
    else implemented_in.push({ repo, file, line, kind });
  }
  return { ok: true, row: { ...req, implemented_in, verified_in }, platformEmpty: false };
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
