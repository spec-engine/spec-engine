// packages/engine/src/provenance/format.ts
//
// PMAT-01 / PMAT-02: pure formatter for the provenance matrix. Takes
// ProvenanceMatrixRow[] in (from storage.provenanceMatrix() — which reads
// the widened `provenance_matrix` SQL VIEW), returns string out — a
// per-requirement human view or a deterministic JSON projection. No I/O,
// no Storage, no bun:sqlite. Both the CLI (commands/provenance.ts) and the
// Phase 16 webapp render through THIS function, so the two surfaces cannot
// drift (Invariant: one engine, not two).
//
// PMAT-01: per requirement, render its creating issue, its revising/
//   retiring issues (supersedes-via / amends-via), the backing tests
//   (implemented/verified/test_levels), and the git pointer
//   (source_file:line).
// PMAT-02: deterministic sort on the FULL composite key (req_id via the
//   domain-then-numeric-seq comparator, then role, then issue_id, then
//   source_file, then line). This key MUST match the Plan 01 storage
//   ORDER BY exactly so JSON-mode output is byte-stable across cold
//   rebuilds (Pitfall 2 — JSON is JSON.stringify(sorted), no chrome).
//
// Sort key rationale (copied from map/format.ts reqSeq/comparator):
//   - domain_key alphabetic: AUTH before BILLING.
//   - req_seq numeric (parseInt on the suffix after "-"): BILLING-9 must
//     come before BILLING-10 — lexicographic compare would put 10 first.
//   - then role / issue_id / source_file (localeCompare), line numeric.
//
// D-08 grep-fence: this file does not import bun:sqlite.

import type { ProvenanceMatrixRow } from "@spec-engine/shared";
import type { RenderMode } from "../constants";

/**
 * Parse the numeric sequence suffix from a requirement id like
 * "BILLING-009" → 9. Mirrors map/format.ts's reqSeq — falls back to 0 for
 * ids without a parseable suffix (defensive; ID_RE-filtered ids always
 * have one).
 */
function reqSeq(reqId: string): number {
  const parts = reqId.split("-");
  if (parts.length < 2) return 0;
  const n = Number.parseInt(parts[1] ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compare two requirement ids by (domain key ASC, seq numeric ASC).
 * BILLING-9 sorts before BILLING-10 — lexicographic compare would not.
 */
function compareReqIds(a: string, b: string): number {
  const keyCmp = (a.split("-")[0] ?? "").localeCompare(b.split("-")[0] ?? "");
  if (keyCmp !== 0) return keyCmp;
  const seqCmp = reqSeq(a) - reqSeq(b);
  if (seqCmp !== 0) return seqCmp;
  return a.localeCompare(b);
}

/**
 * Deterministically sort provenance rows on the FULL composite key
 * (req_id via compareReqIds, then role, then issue_id, then source_file,
 * then line). Returns a NEW array — never mutates input. This sort MUST
 * match the Plan 01 storage ORDER BY (req_id, role, issue_id, source_file,
 * line) so JSON-mode output is byte-stable across cold rebuilds (PMAT-02).
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

/** One-cell backing-test summary for a provenance link's requirement:
 *   - implemented && verified → "src+test"
 *   - implemented only        → "src"
 *   - verified only           → "test"
 *   - neither                 → "—" (em-dash U+2014)
 *  With the test_levels (GROUP_CONCAT) appended in parens when present. */
function backingTests(row: ProvenanceMatrixRow): string {
  let base: string;
  if (row.implemented === 1 && row.verified === 1) base = "src+test";
  else if (row.implemented === 1) base = "src";
  else if (row.verified === 1) base = "test";
  else base = "—";
  return row.test_levels ? `${base} (${row.test_levels})` : base;
}

/**
 * Render the provenance matrix. Always sorts first via sortProvenance.
 *
 * mode="json": JSON.stringify(sorted) — no indentation, no trailing
 *   newline. Pretty-printing would break byte-stability (PMAT-02).
 *
 * mode="text": a per-requirement view. Rows are grouped by req_id (in
 *   sorted order); each requirement prints a header line (id + status +
 *   backing-test summary) followed by one indented line per provenance
 *   link: `<role>  <issue_id>  <source_file>:<line>`. The role label and
 *   the issue_id are rendered verbatim — the issue_id is opaque and is
 *   never resolved against requirements (PROV-02/SC3).
 *
 *   Empty input → "" (no rows means nothing to render). No trailing
 *   newline — the CLI's console.log adds one.
 */
export function renderProvenance(rows: ProvenanceMatrixRow[], mode: RenderMode): string {
  const sorted = sortProvenance(rows);

  if (mode === "json") {
    return JSON.stringify(sorted);
  }

  // Text mode.
  if (sorted.length === 0) return "";

  // Group sorted rows by req_id. sortProvenance already orders by
  // (req_id, role, issue_id, source_file, line), so Map iteration order
  // (insertion order) is the render order we want.
  const byReq = new Map<string, ProvenanceMatrixRow[]>();
  for (const row of sorted) {
    const bucket = byReq.get(row.req_id);
    if (bucket) bucket.push(row);
    else byReq.set(row.req_id, [row]);
  }

  const lines: string[] = [];
  for (const [reqId, links] of byReq) {
    // One requirement header — status + the aggregated backing-test summary
    // (same across the requirement's links since the VIEW aggregates per req).
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

// ---------------------------------------------------------------------------
// Phase 16 (PWEB-02 / PWEB-03): the ONE shared decorator both the CLI and the
// webapp render through, so the two surfaces cannot drift (one engine, not two).
//
// This file stays ADAPTER-FREE: the decorator accepts a PLAIN resolved-shape map
// — NOT the tracker TrackerResult type or the adapter itself. The surface module
// provenance/resolve.ts owns the tracker-package import and maps TrackerResult →
// ResolvedShape before calling in here. This keeps format.ts inside the
// engine-internal import fence (no tracker import) and shared-package-only.
// ---------------------------------------------------------------------------

/**
 * The plain resolved shape the decorator consumes — a 1:1 projection of a
 * tracker resolve that DELIBERATELY drops `reason`. Branching is ONLY on `ok`:
 * an absent adapter (noop, reason "absent") and a failed adapter (unauthorized,
 * offline, …) both arrive here as `{ ok: false }`, so the rendered degraded
 * output is byte-identical across both — parity by construction (PWEB-03 /
 * Pitfall 3). On `ok:true`, title/status/url carry the resolved metadata.
 */
export type ResolvedShape = {
  ok: boolean;
  title?: string;
  status?: string;
  url?: string;
};

/**
 * The one-line degradation hint, naming the env var verbatim. Rendered for
 * EVERY `ok:false` (and for an id missing from the map) — never branched on the
 * underlying reason, so absent and failed are indistinguishable in the output.
 */
export const TOKEN_HINT = "set SPEC_TRACKER_TOKEN to resolve issue titles";

/**
 * Render a single provenance link line, overlaying resolved tracker metadata
 * when `resolved?.ok` is truthy and otherwise degrading to the bare opaque
 * `issue_id` + the TOKEN_HINT. Branches ONLY on `resolved?.ok` — it never reads
 * a `reason` (the shape carries none), so an absent adapter and a failed adapter
 * produce byte-identical output (PWEB-03). `undefined` (id missing from the
 * resolved map) takes the same degraded path as `{ ok: false }`.
 */
export function decorateRow(row: ProvenanceMatrixRow, resolved: ResolvedShape | undefined): string {
  const prefix = `  ${row.role}  ${row.issue_id}  ${row.source_file}:${row.line}`;
  // WR-02: only overlay when the ok:true result actually carries the required
  // fields. The Linear adapter fills title/status/url on every ok:true, but the
  // decorator is the shared, adapter-agnostic seam — a second adapter, a test
  // double, or a hand-edited sidecar entry could supply `{ ok: true }` with
  // empty/missing fields. The old `?? ""` fallbacks rendered such a hit as a
  // malformed `… [] ` line (dangling bracket, trailing space). Treat an ok:true
  // with empty title or url as a DEGRADE so the overlay is never half-rendered.
  if (resolved?.ok && resolved.title && resolved.url) {
    // Overlay: <title> [<status>] <url> on the same link line.
    return `${prefix}  ${resolved.title} [${resolved.status ?? ""}] ${resolved.url}`;
  }
  // Degraded (absent OR failed OR unresolved OR ok:true-with-empty-fields):
  // bare opaque id + the hint.
  return `${prefix}  (${TOKEN_HINT})`;
}

/**
 * Decorated counterpart of `renderProvenance` — the parity-by-construction
 * render path both the CLI `--resolve-issues` flag (Plan 01) and the webapp
 * (Plan 02) call, so they cannot drift. Always sorts first via `sortProvenance`.
 *
 * mode="json": `JSON.stringify(sorted.map(r => ({ ...r, resolved })))` where
 *   `resolved` is the plain `{title,status,url}` on an `ok:true` hit and `null`
 *   on any miss/degrade — deterministic and byte-comparable (the webapp asserts
 *   byte-equality against this same call in Plan 02). No indentation, no
 *   trailing newline (PMAT-02 byte-stability).
 *
 * mode="text": mirrors `renderProvenance`'s per-requirement grouping but renders
 *   each link line through `decorateRow`. Empty input → "" (no trailing newline).
 */
export function renderProvenanceDecorated(
  rows: ProvenanceMatrixRow[],
  resolved: Map<string, ResolvedShape>,
  mode: RenderMode,
): string {
  const sorted = sortProvenance(rows);

  if (mode === "json") {
    // WR-01: the JSON arm degrades to `resolved: null` — a STRUCTURED, hint-free
    // marker — whereas the text arm (decorateRow) degrades to the visible
    // TOKEN_HINT string. This is an intentional SHAPE difference, not drift: JSON
    // members are machines that read structured fields, so `null` is the
    // canonical "not resolved" signal; the text/webapp surfaces render human
    // chrome (the env-var hint). The webapp ONLY consumes the text arm
    // (server/api.ts → renderProvenanceDecorated(rows, resolved, "text")), so this
    // `null` shape is NEVER what the page renders. The contract is pinned by a
    // snapshot test in provenance-decorate.test.ts so the two arms can't drift.
    return JSON.stringify(
      sorted.map((r) => {
        const hit = resolved.get(r.issue_id);
        const resolvedField =
          hit?.ok === true
            ? { title: hit.title ?? "", status: hit.status ?? "", url: hit.url ?? "" }
            : null;
        return { ...r, resolved: resolvedField };
      }),
    );
  }

  // Text mode — same grouping as renderProvenance, decorated link lines.
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
