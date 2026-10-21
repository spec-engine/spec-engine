// Scoped to `livesIn`, not free field text: the @-ref path rule ("contains a
// slash") also matches scoped npm names like `@spec-engine/spec-engine`.
// Superseded and deprecated entries are exempt; their files are expected to
// disappear. Reads SPEC.json directly: `livesIn` has no index column.

import {
  type Diagnostic,
  DiagnosticCode,
  parseDomainText,
  type SpecRequirement,
} from "@spec-engine/shared";
import { listDomainKeys } from "../authoring/domains";
import { resolveFileRef } from "../authoring/filerefs";
import { specPaths } from "../constants";
import { findRequirementIdLine } from "../parser/requirementLine";

const CHECKED_STATUSES = new Set(["active", "draft"]);

interface RawDomain {
  raw: string;
  requirements: readonly SpecRequirement[];
}

/** Read one domain envelope. Malformed files are skipped — structural
 *  validation owns those. */
async function readDomain(platformDir: string, key: string): Promise<RawDomain | null> {
  const { abs, rel } = specPaths(platformDir, key);
  let raw: string;
  try {
    raw = await Bun.file(abs).text();
  } catch {
    return null;
  }
  const parsed = parseDomainText(raw, rel);
  return parsed.ok ? { raw, requirements: parsed.data.requirements } : null;
}

/** The BROKEN_FILE_REF rows for one requirement's `livesIn` list. */
function rowsForRequirement(
  platformDir: string,
  key: string,
  reqId: string,
  livesIn: readonly string[],
  line: number,
): Diagnostic[] {
  const rows: Diagnostic[] = [];
  for (const entry of livesIn) {
    const ref = entry.startsWith("@") ? entry.slice(1) : entry;
    if (ref.length === 0 || resolveFileRef(platformDir, ref)) continue;
    rows.push({
      code: DiagnosticCode.BROKEN_FILE_REF,
      severity: "error",
      repo: null,
      source_file: specPaths(platformDir, key).rel,
      line,
      req_id: reqId,
      detail: `livesIn entry ${entry} does not resolve to a file under the platform root`,
    });
  }
  return rows;
}

/** The BROKEN_FILE_REF rows for one domain. */
function rowsForDomain(platformDir: string, key: string, domain: RawDomain): Diagnostic[] {
  const rows: Diagnostic[] = [];
  const rawLines = domain.raw.split("\n");
  let lineCursor = 0;

  for (const req of domain.requirements) {
    // Resolve the line before the status filter so the cursor stays monotonic
    // across entries this pass skips.
    const found = findRequirementIdLine(rawLines, req.id, lineCursor);
    if (found >= 0) lineCursor = found + 1;

    if (!CHECKED_STATUSES.has(req.status.toLowerCase())) continue;

    rows.push(
      ...rowsForRequirement(platformDir, key, req.id, req.livesIn, found >= 0 ? found + 1 : 0),
    );
  }
  return rows;
}

/** All BROKEN_FILE_REF diagnostics for the platform, sorted. */
// @spec CHCK-026
// @spec CHCK-027
// @spec CHCK-028
export async function brokenFileRefDiagnostics(platformDir: string): Promise<Diagnostic[]> {
  const rows: Diagnostic[] = [];
  for (const key of listDomainKeys(platformDir)) {
    const domain = await readDomain(platformDir, key);
    if (domain !== null) rows.push(...rowsForDomain(platformDir, key, domain));
  }
  rows.sort(
    (a, b) =>
      (a.source_file ?? "").localeCompare(b.source_file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.req_id ?? "").localeCompare(b.req_id ?? "") ||
      a.detail.localeCompare(b.detail),
  );
  return rows;
}
