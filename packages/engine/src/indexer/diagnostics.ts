// packages/engine/src/indexer/diagnostics.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INDX-002
//
// PARS-02: structural-integrity validator that runs over the union of
// parsed SPEC.md files. Emits five codes:
//   - DUP_ID                  — a requirement.id appears in more than one place
//   - BROKEN_SUPERSEDE        — `superseded_by` points to a non-existent id
//   - BAD_STATUS              — `status` is not one of {Active,Draft,Retired,Superseded}
//   - CYCLIC_SUPERSEDE        — the supersession chain loops (A→B→A)
//   - SELF_RELATES            — a Relates: token names its own requirement (warning)
//
// Invariant #4 (parsed spec is canonical; DB has no CHECK constraints):
// bad rows STILL land in the `requirements` table. This validator only
// produces diagnostic rows. The indexer pipeline (pipeline.ts) inserts
// EVERY parsed requirement regardless of what diagnostics say.
//
// Source pattern: 02-RESEARCH § Structural diagnostics (lines 1019-1042)
// + § Spec parsing strategy → validateStructure (lines 869-905).
//
// Pitfall 3 (BAD_STATUS surfacing): the parser casts an Invalid status
// through `RequirementStatus` so the row can land. Here we recognize that
// cast by literal-set check and emit BAD_STATUS with the raw token.
//
// Purity: no I/O, no bun:sqlite import (D-08 grep-fence).
//
// Structure: `validateStructure` builds the shared id maps ONCE and then
// concatenates one named detector per diagnostic pass, in the SAME pass
// order the rows were historically emitted so output stays byte-identical.
// Each detector is self-contained and scores ≤15 for cognitive complexity.

import {
  DiagnosticCode,
  type ParseDiagnostic,
  REQUIREMENT_STATUSES,
  type RequirementStatus,
} from "@spec-engine/shared";
import type { ParsedSpec } from "../parser/types";

// A diagnostic row before the storage upsert assigns its auto-increment id.
type Diagnostic = Omit<ParseDiagnostic, "id">;

// Set for BAD_STATUS detection, built from the shared single-source array so
// a future widening of the status vocabulary flows here automatically.
const VALID_STATUSES: ReadonlySet<RequirementStatus> = new Set(REQUIREMENT_STATUSES);

/** First-seen location of a requirement id (id → where it was first parsed). */
type FirstSeen = ReadonlyMap<string, { source_file: string; line: number }>;

/** First-seen supersession edge (id → `superseded_by`), DUP collisions keep the first. */
type SupersedeEdges = ReadonlyMap<string, string | null>;

interface IdMaps {
  firstSeen: FirstSeen;
  byId: SupersedeEdges;
}

/**
 * Build the two shared id maps in a single walk so no detector rebuilds them:
 *   - `firstSeen`: id → first-seen {source_file, line} (drives DUP_ID's cited
 *     location and BROKEN_SUPERSEDE's existence check).
 *   - `byId`: id → `superseded_by`, first-seen wins on DUP_ID collision
 *     (matching Pass 1), the graph the cyclic walker traverses.
 */
function buildIdMaps(specs: ParsedSpec[]): IdMaps {
  const firstSeen = new Map<string, { source_file: string; line: number }>();
  const byId = new Map<string, string | null>();
  for (const spec of specs) {
    for (const r of spec.requirements) {
      if (!firstSeen.has(r.id)) firstSeen.set(r.id, { source_file: r.source_file, line: r.line });
      // DUP_ID collisions keep the first-seen edge, matching Pass 1.
      if (!byId.has(r.id)) byId.set(r.id, r.superseded_by);
    }
  }
  return { firstSeen, byId };
}

/**
 * Pass 1: DUP_ID. On collision, emit against the SECOND (and any subsequent)
 * occurrence, citing the first-seen location from `firstSeen`.
 */
function detectDupId(specs: ParsedSpec[], firstSeen: FirstSeen): Diagnostic[] {
  const out: Diagnostic[] = [];
  const counted = new Set<string>();
  for (const spec of specs) {
    for (const r of spec.requirements) {
      if (!counted.has(r.id)) {
        counted.add(r.id);
        continue;
      }
      const first = firstSeen.get(r.id);
      if (first === undefined) continue; // unreachable: counted ⟹ firstSeen has it
      // WR-02 review-fix: carry the colliding id on the second-seen row so
      // `spec check` can link the row back to a requirement. The first
      // occurrence is NOT flagged (it's the "real" req); only subsequent
      // duplicates emit DUP_ID, and each one knows its own id.
      out.push({
        code: DiagnosticCode.DUP_ID,
        source_file: r.source_file,
        line: r.line,
        req_id: r.id,
        detail: `Duplicate requirement id ${r.id}; first seen at ${first.source_file}:${first.line}`,
        severity: "error",
      });
    }
  }
  return out;
}

/**
 * Pass 2: BROKEN_SUPERSEDE. A requirement may declare
 * `### KEY-NNN — Superseded by KEY-MMM`. If KEY-MMM does not exist in the
 * parsed set, emit BROKEN_SUPERSEDE on the referencing requirement.
 */
function detectBrokenSupersede(specs: ParsedSpec[], firstSeen: FirstSeen): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const spec of specs) {
    for (const r of spec.requirements) {
      if (r.superseded_by !== null && !firstSeen.has(r.superseded_by)) {
        // WR-02 review-fix: the defect is on `r.id`'s SPEC.md line — the
        // referencing requirement is the one with the broken pointer.
        out.push({
          code: DiagnosticCode.BROKEN_SUPERSEDE,
          source_file: r.source_file,
          line: r.line,
          req_id: r.id,
          detail: `${r.id} superseded_by ${r.superseded_by} which does not exist`,
          severity: "error",
        });
      }
    }
  }
  return out;
}

/**
 * Pass 3: BAD_STATUS. The parser casts an Invalid status through
 * RequirementStatus (Pitfall 3) so we test the runtime value, not the type.
 * Anything outside VALID_STATUSES is BAD_STATUS.
 */
function detectBadStatus(specs: ParsedSpec[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const spec of specs) {
    for (const r of spec.requirements) {
      if (!VALID_STATUSES.has(r.status)) {
        // WR-02 review-fix: BAD_STATUS is a defect on `r.id`'s `### KEY-NNN`
        // header line — the id is known at the seam.
        out.push({
          code: DiagnosticCode.BAD_STATUS,
          source_file: r.source_file,
          line: r.line,
          req_id: r.id,
          detail: `Bad status on ${r.id}: ${JSON.stringify(r.status)}`,
          severity: "error",
        });
      }
    }
  }
  return out;
}

/**
 * Walk the supersession chain from `startId` over its first outgoing edge
 * `firstEdge`. Each requirement has at most one outgoing edge, so the start
 * is ON a cycle iff the walk returns to it (a node merely pointing INTO a
 * cycle never re-reaches itself). Returns the traversed `path` (excluding the
 * closing hop) so the caller can render the loop.
 */
function walkSupersedeChain(
  startId: string,
  firstEdge: string,
  byId: SupersedeEdges,
): { cyclic: boolean; path: string[] } {
  const path: string[] = [startId];
  const visited = new Set<string>([startId]);
  let next = firstEdge;
  while (true) {
    if (next === startId) return { cyclic: true, path };
    if (visited.has(next) || !byId.has(next)) break; // inner loop or chain end
    visited.add(next);
    path.push(next);
    const n = byId.get(next);
    if (n === null || n === undefined) break;
    next = n;
  }
  return { cyclic: false, path };
}

/**
 * Pass 4 (T6): CYCLIC_SUPERSEDE. Error severity — the chain is the change
 * history, and a loop is corrupt history (contrast the propagation CTE, which
 * just stops at its depth guard). Delegates the per-node walk to
 * `walkSupersedeChain`.
 */
function detectCyclicSupersede(specs: ParsedSpec[], byId: SupersedeEdges): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const spec of specs) {
    for (const r of spec.requirements) {
      if (r.superseded_by === null) continue;
      const { cyclic, path } = walkSupersedeChain(r.id, r.superseded_by, byId);
      if (cyclic) {
        out.push({
          code: DiagnosticCode.CYCLIC_SUPERSEDE,
          source_file: r.source_file,
          line: r.line,
          req_id: r.id,
          detail: `Supersession chain loops: ${[...path, r.id].join(" → ")}`,
          severity: "error",
        });
      }
    }
  }
  return out;
}

/**
 * Pass 5 (T5): SELF_RELATES. The parser drops self-referencing Relates tokens
 * from the relations set but surfaces them (one per requirement). Warning
 * severity — the entry still indexes normally; only the self-link is ignored.
 */
function detectSelfRelates(specs: ParsedSpec[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const spec of specs) {
    for (const s of spec.self_relates) {
      out.push({
        code: DiagnosticCode.SELF_RELATES,
        source_file: s.source_file,
        line: s.line,
        req_id: s.req_id,
        detail: `${s.req_id} Relates: references itself — the self-link is ignored`,
        severity: "warning",
      });
    }
  }
  return out;
}

/**
 * Pass 6 (PROV-05): UNKNOWN_ROLE. The parser surfaces `**Issues:**` tokens
 * whose role is outside the closed allow-list {created, supersedes-via,
 * amends-via}, or which have no `role:ID` colon shape. Those tokens are NOT
 * stored in `provenance`; here we emit one warning per surfaced token so the
 * author sees the line. The entry still indexes normally — only the malformed
 * Issues token is dropped.
 */
function detectUnknownRole(specs: ParsedSpec[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const spec of specs) {
    for (const u of spec.unknown_roles) {
      out.push({
        code: DiagnosticCode.UNKNOWN_ROLE,
        source_file: u.source_file,
        line: u.line,
        req_id: u.req_id,
        detail: `${u.req_id} **Issues:** uses unknown role ${JSON.stringify(u.role)} — allowed: created, supersedes-via, amends-via`,
        severity: "warning",
      });
    }
  }
  return out;
}

/**
 * Run structural validation over the union of every parsed SPEC.md file.
 *
 * The input `specs` array is NOT mutated. Returns one or more diagnostic
 * rows (sans the auto-increment `id` — that's assigned by the storage
 * upsert). The six detectors are concatenated in historical pass order so
 * row order is byte-identical to the pre-split single-function version.
 */
export function validateStructure(specs: ParsedSpec[]): Diagnostic[] {
  const { firstSeen, byId } = buildIdMaps(specs);
  return [
    ...detectDupId(specs, firstSeen),
    ...detectBrokenSupersede(specs, firstSeen),
    ...detectBadStatus(specs),
    ...detectCyclicSupersede(specs, byId),
    ...detectSelfRelates(specs),
    ...detectUnknownRole(specs),
  ];
}
