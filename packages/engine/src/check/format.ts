// The sort order is pinned: the planted-fixture diagnostic baseline is
// compared byte for byte, and the SQL side orders `repo NULLS LAST` the same
// way. The final req_id key exists because UNSOURCED_CHANGE rows collide on
// every prior key.

import type { Diagnostic } from "@spec-engine/shared";
import type { RenderMode } from "../constants";

function compareRepoNullsLast(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const codeCmp = a.code.localeCompare(b.code);
  if (codeCmp !== 0) return codeCmp;

  const repoCmp = compareRepoNullsLast(a.repo, b.repo);
  if (repoCmp !== 0) return repoCmp;

  const fileCmp = (a.source_file ?? "").localeCompare(b.source_file ?? "");
  if (fileCmp !== 0) return fileCmp;

  const lineCmp = (a.line ?? 0) - (b.line ?? 0);
  if (lineCmp !== 0) return lineCmp;

  return (a.req_id ?? "").localeCompare(b.req_id ?? "");
}

export function sortDiagnostics(rows: Diagnostic[]): Diagnostic[] {
  return [...rows].sort(compareDiagnostics);
}

export function renderDiagnostics(rows: Diagnostic[], mode: RenderMode): string {
  const sorted = sortDiagnostics(rows);

  if (mode === "json") {
    return JSON.stringify(sorted);
  }

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
