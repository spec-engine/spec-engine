// packages/engine/src/check/filerefs.ts
//
// The BROKEN_FILE_REF check pass. A requirement's `livesIn` entries name the
// files that carry the behavior; this pass resolves each one against the
// platform root and reports the ones that do not exist.
//
// Scoped to `livesIn`, NOT to free field text. The @-ref grammar's only rule
// for telling a path from any other `@token` is "contains a slash", which a
// scoped npm package name also satisfies — DIST-010's statement mentions
// `@spec-engine/spec-engine` and would report as a missing file. `livesIn` is
// a structured list of paths, so it carries no such ambiguity.
//
// Terminal-status entries (superseded/deprecated) are history: the file a
// retired requirement used to live in is expected to disappear, so only
// Active and Draft entries are judged.
//
// Reads the SPEC.json files straight from the filesystem, mirroring the
// grammar pass — `livesIn` has no index column, so there is nothing to read
// back and no SCHEMA_VERSION bump involved.

import { type Diagnostic, DiagnosticCode } from "@spec-engine/shared";
import { listDomainKeys } from "../authoring/domains";
import { resolveFileRef } from "../authoring/filerefs";
import { specPaths } from "../constants";
import { findRequirementIdLine } from "../parser/requirementLine";

const CHECKED_STATUSES = new Set(["active", "draft"]);

interface RawDomain {
  raw: string;
  requirements: Array<{ id?: unknown; status?: unknown; livesIn?: unknown }>;
}

/** Read one domain envelope. Malformed files are skipped — structural
 *  validation owns those. */
async function readDomain(platformDir: string, key: string): Promise<RawDomain | null> {
  try {
    const raw = await Bun.file(specPaths(platformDir, key).abs).text();
    const doc = JSON.parse(raw) as { requirements?: unknown };
    return {
      raw,
      requirements: Array.isArray(doc.requirements) ? doc.requirements : [],
    };
  } catch {
    return null;
  }
}

/** The BROKEN_FILE_REF rows for one requirement's `livesIn` list. */
function rowsForRequirement(
  platformDir: string,
  key: string,
  reqId: string,
  livesIn: unknown,
  line: number,
): Diagnostic[] {
  if (!Array.isArray(livesIn)) return [];
  const rows: Diagnostic[] = [];
  for (const entry of livesIn) {
    if (typeof entry !== "string") continue;
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
    if (typeof req?.id !== "string") continue;
    // Resolve the line before the status filter so the cursor stays monotonic
    // across entries this pass skips.
    const found = findRequirementIdLine(rawLines, req.id, lineCursor);
    if (found >= 0) lineCursor = found + 1;

    const status = typeof req.status === "string" ? req.status.toLowerCase() : "";
    if (!CHECKED_STATUSES.has(status)) continue;

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
