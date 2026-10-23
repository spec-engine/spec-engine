import { validateAndWrite } from "@spec-engine/shared";
import { listDomainKeys } from "../authoring/domains";
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
