import { type Diagnostic, DiagnosticCode, validateAndWrite } from "@spec-engine/shared";
import { listDomainKeys } from "../authoring/domains";
import { specPaths } from "../constants";
import { readEnvelope } from "./_envelope";
import { fail, type OpFailure } from "./_result";

// An escaped quote inside a JSON string is preceded by a backslash, so
// statement text that mentions a key name never matches.
const LEGACY_KEY_RE = /(?<!\\)"(?:livesIn|verifiedIn)"\s*:/;

export interface MigrateResult {
  ok: true;
  /** Platform-relative SPEC.json paths rewritten, in key order. */
  files: string[];
}

/**
 * One MIGRATION_PENDING warning per SPEC.json whose raw text still carries a
 * retired key. A missing or unreadable file is another check's finding.
 * @spec CHCK-054
 */
export async function migrationPendingDiagnostics(platformDir: string): Promise<Diagnostic[]> {
  const rows: Diagnostic[] = [];
  for (const key of listDomainKeys(platformDir)) {
    const { abs, rel } = specPaths(platformDir, key);
    const raw = await Bun.file(abs)
      .text()
      .catch(() => "");
    if (!LEGACY_KEY_RE.test(raw)) continue;
    rows.push({
      code: DiagnosticCode.MIGRATION_PENDING,
      severity: "warning",
      repo: null,
      source_file: rel,
      line: null,
      req_id: null,
      detail: `${rel} still carries the retired livesIn or verifiedIn fields; run spec migrate to strip them`,
    });
  }
  return rows;
}

/**
 * The parse has already dropped both keys, so the raw text decides which
 * files carry them; the write seam does the stripping.
 * @spec SCHM-039
 */
export async function migrate(platformDir: string): Promise<MigrateResult | OpFailure> {
  const files: string[] = [];
  for (const key of listDomainKeys(platformDir)) {
    const file = await readEnvelope(platformDir, key);
    if (!file.ok) return file;
    if (!LEGACY_KEY_RE.test(await Bun.file(file.specPath).text())) continue;
    const res = await validateAndWrite(file.specPath, file.domain, file.relFile);
    if (!res.ok) {
      return fail("invalid_domain_file", res.diagnostics.map((d) => d.detail).join("\n"), {
        diagnostics: res.diagnostics,
      });
    }
    files.push(file.relFile);
  }
  return { ok: true, files };
}
