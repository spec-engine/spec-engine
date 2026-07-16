// packages/engine/src/check/sqlDiagnostics.ts
//
// Orchestrator: pulls together the two diagnostic streams (semantic Q1..Q5
// from the populated index, structural DUP_ID/BROKEN_SUPERSEDE/BAD_STATUS
// from parse_diagnostics) and returns one unified Diagnostic[] for the
// formatter to sort + render.
//
// This is the seam Pattern 1 from 03-RESEARCH § Architecture Patterns: a
// pure function (Storage → Diagnostic[]), no I/O of its own, easy to swap
// in a Rust implementation later because every call goes through the
// Storage interface from @spec-engine/shared.
//
// Adapter rule (03-RESEARCH § Diagnostic SQL § Structural diagnostics):
// ParseDiagnostic rows describe SPEC.md spec-side defects (DUP_ID,
// BROKEN_SUPERSEDE, BAD_STATUS). They have no `repo` (the defect is in the
// SPEC, not in a member repo), so we fill `repo: null`. Per WR-02
// (03-REVIEW), `req_id` is preserved from the parse pass — the parser
// records the implicated id on every structural diagnostic it emits
// (validateStructure in indexer/diagnostics.ts). If a future code is added
// that legitimately lacks an id, ParseDiagnostic.req_id is nullable.
//
// Ordering: NOT this function's job. Members concatenate semantic +
// structural in a deliberate but unsorted order; renderDiagnostics
// (check/format.ts) applies the deterministic (code, repo NULLS LAST,
// source_file, line) sort. Splitting responsibility this way keeps each
// function trivially testable.
//
// D-08 grep-fence: this file does not import bun:sqlite.

import type { Diagnostic, ParseDiagnostic, Storage } from "@spec-engine/shared";

/**
 * Collect every diagnostic for `spec check` to print. Returns the union of:
 *   - `storage.listSemanticDiagnostics()` — Q1..Q5 (DANGLING_TAG,
 *     SUPERSEDED_REFERENCED, DRIFT, ORPHAN_REQ, UNVERIFIED_REQ). Already
 *     Diagnostic-compatible: SemanticDiagnostic's `source_file: string` +
 *     `line: number` are assignable to Diagnostic's nullable fields.
 *   - `storage.listDiagnostics()` adapted via repo:null/req_id:null — the
 *     structural codes (DUP_ID, BROKEN_SUPERSEDE, BAD_STATUS).
 */
export function collectDiagnostics(storage: Storage): Diagnostic[] {
  const semantic = storage.listSemanticDiagnostics();

  // Adapt ParseDiagnostic → Diagnostic. Spec-side defects don't carry a
  // `repo` (the defect is in the SPEC); fill repo:null. `req_id` flows
  // through verbatim per WR-02 (03-REVIEW) — it's populated upstream in
  // validateStructure for DUP_ID/BROKEN_SUPERSEDE/BAD_STATUS, and is still
  // nullable on the Diagnostic shape so the adapter passes the null
  // through unchanged when no id is known.
  const adapted: Diagnostic[] = storage.listDiagnostics().map(
    (p: ParseDiagnostic): Diagnostic => ({
      code: p.code,
      source_file: p.source_file,
      line: p.line,
      repo: null,
      req_id: p.req_id,
      detail: p.detail,
      severity: p.severity,
    }),
  );

  return [...semantic, ...adapted];
}
