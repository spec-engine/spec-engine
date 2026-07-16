// packages/engine/src/check/format.ts
//
// Pure formatter for the unified Diagnostic[] surface emitted by
// `spec check`. Takes rows-in, returns string-out — no I/O, no Storage,
// no bun:sqlite. The orchestrator (sqlDiagnostics.ts) supplies the rows;
// the citty command (commands/check.ts) prints whatever string this
// returns and adds a single console.log newline.
//
// CHCK-02 / CHCK-04 surface contract:
//   - Sort order: (code ASC, repo NULLS LAST, source_file ASC, line ASC).
//     Locked here because the inverted CI assertion in plan 03-05 is a
//     string-equality check; reordering anywhere would silently break it.
//   - JSON mode: `JSON.stringify(sorted)` — a single array, no spaces, no
//     trailing newline. Deterministic byte output.
//   - Text mode: tab-separated per row, newline-joined, no trailing newline.
//     Caller's console.log adds one trailing newline.
//
// D-08 grep-fence: this file does not import bun:sqlite.
// Pattern source: 03-RESEARCH.md § Diagnostics Output Format (lines 658-705).

import type { Diagnostic } from "@spec-engine/shared";
import type { RenderMode } from "../constants";

/**
 * Compare two repo values under the "NULLS LAST" rule: non-null repos sort
 * BEFORE null repos, alphabetically among themselves; null repos sort after.
 * This matches the SQL-side `ORDER BY repo NULLS LAST` semantic 03-RESEARCH
 * specifies for the diagnostic UNION. Returns 0 when the key does not decide
 * the order (equal repos, or two distinct strings that collate equal), letting
 * the caller fall through to the next sort key.
 */
function compareRepoNullsLast(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

/**
 * Full row comparator for (code, repo NULLS LAST, source_file, line, req_id).
 * Each key short-circuits on a non-zero result; equal keys fall through to the
 * next. Kept as a top-level named function (not an inline `.sort` arrow) so the
 * per-key tie-break chain stays flat and readable.
 *
 * WR-01 determinism hardening (Phase 14): the final `req_id` tie-break makes
 * the output independent of caller input order. UNSOURCED_CHANGE rows all
 * share `code` + `repo:null`, so two superseded reqs in different domains
 * that collide on `source_file`/`line` (e.g. both `line:0`) would otherwise
 * fall through to a non-deterministic order. The tie-break does NOT reorder
 * the existing fixtures — no two baseline rows collide on (code, repo,
 * source_file, line) — so the inverted-CI EXPECTED_DIAGNOSTICS stays
 * byte-unchanged.
 */
function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  // Primary key: code ASC.
  const codeCmp = a.code.localeCompare(b.code);
  if (codeCmp !== 0) return codeCmp;

  // Secondary key: repo NULLS LAST (see compareRepoNullsLast).
  const repoCmp = compareRepoNullsLast(a.repo, b.repo);
  if (repoCmp !== 0) return repoCmp;

  // Tertiary key: source_file ASC (null → ""; matches text formatter).
  const fileCmp = (a.source_file ?? "").localeCompare(b.source_file ?? "");
  if (fileCmp !== 0) return fileCmp;

  // Quaternary key: line ASC (null → 0).
  const lineCmp = (a.line ?? 0) - (b.line ?? 0);
  if (lineCmp !== 0) return lineCmp;

  // Quinary key: req_id ASC (null → ""). Final tie-break so rows that
  // collide on every prior key order deterministically (WR-01).
  return (a.req_id ?? "").localeCompare(b.req_id ?? "");
}

/**
 * Deterministically sort diagnostics by (code, repo NULLS LAST, source_file,
 * line, req_id). Returns a NEW array — never mutates input. The "NULLS LAST"
 * rule for repo means non-null repo values sort BEFORE null repo values, with
 * non-nulls ordered alphabetically among themselves.
 */
export function sortDiagnostics(rows: Diagnostic[]): Diagnostic[] {
  return [...rows].sort(compareDiagnostics);
}

/**
 * Render diagnostics deterministically. Mode "text" returns tab-separated
 * lines (one per diagnostic, no trailing newline); mode "json" returns
 * `JSON.stringify(sorted)` with no whitespace argument.
 *
 * Text row shape: `<CODE>\t<repo>\t<source_file>:<line>\t<req_id>\t<detail>`.
 * Null repo / req_id / source_file render as empty strings (not the literal
 * `"null"`). Null line renders as empty after the colon (e.g. `:`).
 */
export function renderDiagnostics(rows: Diagnostic[], mode: RenderMode): string {
  const sorted = sortDiagnostics(rows);

  if (mode === "json") {
    return JSON.stringify(sorted);
  }

  // Text mode: one tab-separated line per diagnostic.
  return sorted
    .map((d) => {
      const repo = d.repo ?? "";
      const file = d.source_file ?? "";
      const line = d.line ?? "";
      const reqId = d.req_id ?? "";
      return `${d.code}\t${repo}\t${file}:${line}\t${reqId}\t${d.detail}`;
    })
    .join("\n");
}
