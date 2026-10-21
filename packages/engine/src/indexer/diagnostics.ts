// @spec INDX-008
//
// Bad rows still land in the `requirements` table: the DB has no CHECK
// constraints, and this validator only produces diagnostic rows.

import {
  DiagnosticCode,
  type ParseDiagnostic,
  REQUIREMENT_STATUSES,
  type RequirementStatus,
} from "@spec-engine/shared";
import type { ParsedSpec } from "../parser/types";

type Diagnostic = Omit<ParseDiagnostic, "id">;

const VALID_STATUSES: ReadonlySet<RequirementStatus> = new Set(REQUIREMENT_STATUSES);

type FirstSeen = ReadonlyMap<string, { source_file: string; line: number }>;

/** A DUP_ID collision keeps the first-seen edge. */
type SupersedeEdges = ReadonlyMap<string, string | null>;

interface IdMaps {
  firstSeen: FirstSeen;
  byId: SupersedeEdges;
}

function buildIdMaps(specs: ParsedSpec[]): IdMaps {
  const firstSeen = new Map<string, { source_file: string; line: number }>();
  const byId = new Map<string, string | null>();
  for (const spec of specs) {
    for (const r of spec.requirements) {
      if (!firstSeen.has(r.id)) firstSeen.set(r.id, { source_file: r.source_file, line: r.line });
      if (!byId.has(r.id)) byId.set(r.id, r.superseded_by);
    }
  }
  return { firstSeen, byId };
}

/** The first occurrence is not flagged; each later one cites it. */
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

function detectBrokenSupersede(specs: ParsedSpec[], firstSeen: FirstSeen): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const spec of specs) {
    for (const r of spec.requirements) {
      if (r.superseded_by !== null && !firstSeen.has(r.superseded_by)) {
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
 * The parser casts an invalid status through `RequirementStatus` so the row
 * can land, so this tests the runtime value, not the type.
 */
function detectBadStatus(specs: ParsedSpec[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const spec of specs) {
    for (const r of spec.requirements) {
      if (!VALID_STATUSES.has(r.status)) {
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
 * Each requirement has at most one outgoing edge, so the start is on a cycle
 * iff the walk returns to it; a node merely pointing into a cycle never
 * re-reaches itself. `path` excludes the closing hop.
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
 * Error, not warning: the chain is the change history and a loop corrupts it.
 * The propagation CTE merely stops at its depth guard.
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

/** Detector order fixes row order; reordering changes the emitted output. */
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
