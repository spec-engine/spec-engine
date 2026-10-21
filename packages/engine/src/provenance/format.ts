// Both the CLI and the webapp render through these functions, so the two
// surfaces cannot drift.

import type { ProvenanceMatrixRow } from "@spec-engine/shared";
import type { RenderMode } from "../constants";

/** Mirrors map/format.ts's reqSeq. */
function reqSeq(reqId: string): number {
  const parts = reqId.split("-");
  if (parts.length < 2) return 0;
  const n = Number.parseInt(parts[1] ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/** BILLING-9 sorts before BILLING-10; a lexicographic compare would not. */
function compareReqIds(a: string, b: string): number {
  const keyCmp = (a.split("-")[0] ?? "").localeCompare(b.split("-")[0] ?? "");
  if (keyCmp !== 0) return keyCmp;
  const seqCmp = reqSeq(a) - reqSeq(b);
  if (seqCmp !== 0) return seqCmp;
  return a.localeCompare(b);
}

/**
 * This key must match the storage `provenance_matrix` ORDER BY so JSON-mode
 * output is byte-stable across cold rebuilds.
 */
export function sortProvenance(rows: ProvenanceMatrixRow[]): ProvenanceMatrixRow[] {
  return [...rows].sort(
    (a, b) =>
      compareReqIds(a.req_id, b.req_id) ||
      a.role.localeCompare(b.role) ||
      a.issue_id.localeCompare(b.issue_id) ||
      a.source_file.localeCompare(b.source_file) ||
      a.line - b.line,
  );
}

function backingTests(row: ProvenanceMatrixRow): string {
  let base: string;
  if (row.implemented === 1 && row.verified === 1) base = "src+test";
  else if (row.implemented === 1) base = "src";
  else if (row.verified === 1) base = "test";
  else base = "—";
  return row.test_levels ? `${base} (${row.test_levels})` : base;
}

/**
 * JSON mode has no indentation: pretty-printing would break byte-stability.
 * The issue_id is opaque and rendered verbatim, never resolved against
 * requirements. No trailing newline: the CLI's console.log adds one.
 */
export function renderProvenance(rows: ProvenanceMatrixRow[], mode: RenderMode): string {
  const sorted = sortProvenance(rows);

  if (mode === "json") {
    return JSON.stringify(sorted);
  }

  if (sorted.length === 0) return "";

  // Map insertion order is the sorted order.
  const byReq = new Map<string, ProvenanceMatrixRow[]>();
  for (const row of sorted) {
    const bucket = byReq.get(row.req_id);
    if (bucket) bucket.push(row);
    else byReq.set(row.req_id, [row]);
  }

  const lines: string[] = [];
  for (const [reqId, links] of byReq) {
    // The view aggregates tests per requirement, so the first link speaks for all.
    const first = links[0];
    const tests = first ? backingTests(first) : "—";
    const status = first ? first.req_status : "";
    lines.push(`${reqId}  [${status}]  tests: ${tests}`);
    for (const link of links) {
      lines.push(`  ${link.role}  ${link.issue_id}  ${link.source_file}:${link.line}`);
    }
  }
  return lines.join("\n");
}

// This file stays adapter-free to sit inside the engine-internal import fence:
// provenance/resolve.ts owns the tracker import and maps TrackerResult to
// ResolvedShape before calling in here.

/**
 * Deliberately drops the tracker's `reason`: an absent adapter and a failed one
 * both arrive as `{ ok: false }`, so their degraded output is byte-identical.
 */
export type ResolvedShape = {
  ok: boolean;
  title?: string;
  status?: string;
  url?: string;
  /** True when the tracker refresh failed and this data is served from an
   *  expired cache entry: degraded data must say it is degraded. */
  stale?: boolean;
};

export const TOKEN_HINT = "set SPEC_TRACKER_TOKEN to resolve issue titles";

export function decorateRow(row: ProvenanceMatrixRow, resolved: ResolvedShape | undefined): string {
  const prefix = `  ${row.role}  ${row.issue_id}  ${row.source_file}:${row.line}`;
  // A second adapter, a test double, or a hand-edited sidecar entry can supply
  // `{ ok: true }` with empty fields; overlaying it would render a malformed
  // `… [] ` line, so an ok:true without title or url degrades instead.
  if (resolved?.ok && resolved.title && resolved.url) {
    // An old title rendered as current is a quiet lie.
    const staleMark = resolved.stale ? " (cached — refresh failed)" : "";
    return `${prefix}  ${resolved.title} [${resolved.status ?? ""}] ${resolved.url}${staleMark}`;
  }
  return `${prefix}  (${TOKEN_HINT})`;
}

export function renderProvenanceDecorated(
  rows: ProvenanceMatrixRow[],
  resolved: Map<string, ResolvedShape>,
  mode: RenderMode,
): string {
  const sorted = sortProvenance(rows);

  if (mode === "json") {
    // The JSON arm degrades to a structured `resolved: null` where the text arm
    // shows TOKEN_HINT. The shape difference is intentional, not drift: machines
    // read fields, humans read the hint. Pinned by format.decorate.test.ts.
    return JSON.stringify(
      sorted.map((r) => {
        const hit = resolved.get(r.issue_id);
        const resolvedField =
          hit?.ok === true
            ? {
                title: hit.title ?? "",
                status: hit.status ?? "",
                url: hit.url ?? "",
                stale: hit.stale === true,
              }
            : null;
        return { ...r, resolved: resolvedField };
      }),
    );
  }

  if (sorted.length === 0) return "";

  const byReq = new Map<string, ProvenanceMatrixRow[]>();
  for (const row of sorted) {
    const bucket = byReq.get(row.req_id);
    if (bucket) bucket.push(row);
    else byReq.set(row.req_id, [row]);
  }

  const lines: string[] = [];
  for (const [reqId, links] of byReq) {
    const first = links[0];
    const tests = first ? backingTests(first) : "—";
    const status = first ? first.req_status : "";
    lines.push(`${reqId}  [${status}]  tests: ${tests}`);
    for (const link of links) {
      lines.push(decorateRow(link, resolved.get(link.issue_id)));
    }
  }
  return lines.join("\n");
}
