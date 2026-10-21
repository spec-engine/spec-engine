// The union is deliberately unsorted: renderDiagnostics owns ordering.

import type { Diagnostic, DiagnosticCode, ParseDiagnostic, Storage } from "@spec-engine/shared";

/** The platform-map codes whose subject may name a member of the platform. */
const PLATFORM_CODES: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  "MALFORMED_FILE",
  "MEMBER_MISSING",
  "MARKER_MISSING",
  "MARKER_MISMATCH",
  "UNLISTED_REPO",
  "PLATFORM_NOT_LOCATED",
  "UNDECLARED_PLATFORM",
  "SCAN_TRUNCATED",
]);

export function collectDiagnostics(storage: Storage): Diagnostic[] {
  const semantic = storage.listSemanticDiagnostics();
  const repoNames = new Set(storage.listRepos().map((r) => r.name));
  // @spec CHCK-031
  const repoOf = (p: ParseDiagnostic): string | null =>
    PLATFORM_CODES.has(p.code) && repoNames.has(p.source_file) ? p.source_file : null;

  // A parse diagnostic is a spec-side defect with no repo, unless it is a
  // platform-map code whose subject names a member.
  const adapted: Diagnostic[] = storage.listDiagnostics().map(
    (p: ParseDiagnostic): Diagnostic => ({
      code: p.code,
      source_file: p.source_file,
      line: p.line,
      repo: repoOf(p),
      req_id: p.req_id,
      detail: p.detail,
      severity: p.severity,
    }),
  );

  return [...semantic, ...adapted];
}
