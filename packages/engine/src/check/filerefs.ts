// Scoped to `livesIn` and `verifiedIn`, not free field text: the @-ref path
// rule ("contains a slash") also matches scoped npm names like
// `@spec-engine/spec-engine`. Superseded and deprecated entries are exempt;
// their files are expected to disappear. Reads SPEC.json directly: neither
// list has an index column.

import {
  type Diagnostic,
  DiagnosticCode,
  parseDomainText,
  type Repo,
  type SpecRequirement,
  type Tag,
  type TagKind,
} from "@spec-engine/shared";
import { listDomainKeys } from "../authoring/domains";
import { resolveFileRef } from "../authoring/filerefs";
import { specPaths } from "../constants";
import { discoverRepos } from "../indexer/discover";
import { scannedTagFile } from "../indexer/pipeline";
import { findRequirementIdLine } from "../parser/requirementLine";

const FILE_REF_STATUSES = new Set(["active", "draft"]);
const IN_FILE_STATUSES = new Set(["active"]);

interface Located {
  sourceFile: string;
  line: number;
  req: SpecRequirement;
}

/** The entries of one domain file whose status is in `statuses`, each with its line. */
function locateInDomain(
  raw: string,
  sourceFile: string,
  requirements: readonly SpecRequirement[],
  statuses: ReadonlySet<string>,
): Located[] {
  const out: Located[] = [];
  const rawLines = raw.split("\n");
  let lineCursor = 0;
  for (const req of requirements) {
    // Resolve the line before the status filter so the cursor stays monotonic
    // across entries this pass skips.
    const found = findRequirementIdLine(rawLines, req.id, lineCursor);
    if (found >= 0) lineCursor = found + 1;
    if (statuses.has(req.status.toLowerCase())) {
      out.push({ sourceFile, line: found >= 0 ? found + 1 : 0, req });
    }
  }
  return out;
}

/** Every requirement whose status is in `statuses`. Malformed files are skipped — structural validation owns those. */
async function locatedEntries(
  platformDir: string,
  statuses: ReadonlySet<string>,
): Promise<Located[]> {
  const out: Located[] = [];
  for (const key of listDomainKeys(platformDir)) {
    const { abs, rel } = specPaths(platformDir, key);
    let raw: string;
    try {
      raw = await Bun.file(abs).text();
    } catch {
      continue;
    }
    const parsed = parseDomainText(raw, rel);
    if (parsed.ok) out.push(...locateInDomain(raw, rel, parsed.data.requirements, statuses));
  }
  return out;
}

function sortRows(rows: Diagnostic[]): Diagnostic[] {
  return rows.sort(
    (a, b) =>
      (a.source_file ?? "").localeCompare(b.source_file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.req_id ?? "").localeCompare(b.req_id ?? "") ||
      a.code.localeCompare(b.code) ||
      a.detail.localeCompare(b.detail),
  );
}

const refOf = (entry: string): string => (entry.startsWith("@") ? entry.slice(1) : entry);

function row(at: Located, code: DiagnosticCode, severity: Diagnostic["severity"], detail: string) {
  return {
    code,
    severity,
    repo: null,
    source_file: at.sourceFile,
    line: at.line,
    req_id: at.req.id,
    detail,
  };
}

/** All BROKEN_FILE_REF diagnostics for the platform, sorted. */
// @spec CHCK-045
// @spec CHCK-027
// @spec CHCK-028
export async function brokenFileRefDiagnostics(platformDir: string): Promise<Diagnostic[]> {
  const rows: Diagnostic[] = [];
  for (const at of await locatedEntries(platformDir, FILE_REF_STATUSES)) {
    for (const [field, entries] of [
      ["livesIn", at.req.livesIn],
      ["verifiedIn", at.req.verifiedIn],
    ] as const) {
      for (const entry of entries) {
        const ref = refOf(entry);
        if (ref.length === 0 || resolveFileRef(platformDir, ref)) continue;
        rows.push(
          row(
            at,
            DiagnosticCode.BROKEN_FILE_REF,
            "error",
            `${field} entry ${entry} does not resolve to a file under the platform root`,
          ),
        );
      }
    }
  }
  return sortRows(rows);
}

/** `"<req_id>\t<file>"` for every tag of a kind in `kinds`. */
function tagKeys(tags: readonly Tag[], kinds: readonly TagKind[]): Set<string> {
  return new Set(tags.filter((t) => kinds.includes(t.kind)).map((t) => `${t.req_id}\t${t.file}`));
}

interface InFileCheck {
  field: "livesIn" | "verifiedIn";
  code: DiagnosticCode;
  keys: Set<string>;
  missing: string;
}

/** The rows one check raises for one entry's list. */
function inFileRows(
  platformDir: string,
  members: readonly Repo[],
  at: Located,
  check: InFileCheck,
): Diagnostic[] {
  const rows: Diagnostic[] = [];
  for (const entry of at.req[check.field]) {
    const ref = refOf(entry);
    if (ref.length === 0 || !resolveFileRef(platformDir, ref)) continue;
    const file = scannedTagFile(members, platformDir, ref);
    if (file === null || check.keys.has(`${at.req.id}\t${file}`)) continue;
    rows.push(
      row(
        at,
        check.code,
        "warning",
        `${check.field} entry ${entry} holds no ${check.missing} tag for ${at.req.id}`,
      ),
    );
  }
  return rows;
}

/**
 * UNIMPLEMENTED_IN_FILE and UNVERIFIED_IN_FILE for every Active requirement,
 * sorted. An entry that does not resolve, or names a file no member scan
 * reads, reports nothing here.
 * @spec CHCK-046
 * @spec CHCK-047
 */
export async function inFileTagDiagnostics(
  platformDir: string,
  tags: readonly Tag[],
): Promise<Diagnostic[]> {
  const { members } = await discoverRepos(platformDir, { quiet: true });
  const checks: InFileCheck[] = [
    {
      field: "livesIn",
      code: DiagnosticCode.UNIMPLEMENTED_IN_FILE,
      keys: tagKeys(tags, ["implements", "documents"]),
      missing: "implementing or documenting",
    },
    {
      field: "verifiedIn",
      code: DiagnosticCode.UNVERIFIED_IN_FILE,
      keys: tagKeys(tags, ["verifies"]),
      missing: "verifying",
    },
  ];
  const rows: Diagnostic[] = [];
  for (const at of await locatedEntries(platformDir, IN_FILE_STATUSES)) {
    for (const check of checks) rows.push(...inFileRows(platformDir, members, at, check));
  }
  return sortRows(rows);
}
