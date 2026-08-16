// packages/engine/src/check/supersedes.ts
//
// Validation for the `supersedes` forward pointer.
//
// A supersede edge is stored in two directions: the predecessor's
// `supersededBy` and the successor's `supersedes`. The index derives lineage
// from `supersededBy` alone, and the authoring commands always write
// `supersedes: null` — but the loss gates (check/removed.ts, guard/losses.ts)
// honor a surviving requirement's `supersedes` as a removal exemption. That
// makes it the one field a hand-edit can use to excuse a deletion, and until
// now nothing checked that it named a real requirement.
//
// This pass closes that: a non-null `supersedes` must name a requirement that
// exists somewhere in the platform, and must not name the declaring entry
// itself. It deliberately does NOT require the target to point back — the
// legal delete-and-replace path leaves no predecessor to carry the return
// pointer, which is the whole reason the backward direction exists (GUARD-018).
//
// Reads the SPEC.json files directly: `supersedes` has no index column.

import { join } from "node:path";
import { type Diagnostic, DiagnosticCode } from "@spec-engine/shared";
import { listDomainKeys } from "../authoring/domains";
import { findRequirementIdLine } from "../parser/requirementLine";

interface RawEntry {
  id: string;
  supersedes: string | null;
  line: number;
  sourceFile: string;
}

/** One domain's entries. Malformed or unreadable files yield none —
 *  structural validation owns those. */
async function entriesForDomain(platformDir: string, key: string): Promise<RawEntry[]> {
  let raw: string;
  let reqs: Array<{ id?: unknown; supersedes?: unknown }>;
  try {
    raw = await Bun.file(join(platformDir, "spec-engine", key, "SPEC.json")).text();
    const doc = JSON.parse(raw) as { requirements?: unknown };
    reqs = Array.isArray(doc.requirements) ? doc.requirements : [];
  } catch {
    return [];
  }

  const out: RawEntry[] = [];
  const rawLines = raw.split("\n");
  let lineCursor = 0;
  for (const r of reqs) {
    if (typeof r?.id !== "string") continue;
    const found = findRequirementIdLine(rawLines, r.id, lineCursor);
    if (found >= 0) lineCursor = found + 1;
    out.push({
      id: r.id,
      supersedes: typeof r.supersedes === "string" ? r.supersedes : null,
      line: found >= 0 ? found + 1 : 0,
      sourceFile: `spec-engine/${key}/SPEC.json`,
    });
  }
  return out;
}

/** Every requirement in the platform, with its declared forward pointer. */
async function collectEntries(platformDir: string): Promise<RawEntry[]> {
  const out: RawEntry[] = [];
  for (const key of listDomainKeys(platformDir)) {
    out.push(...(await entriesForDomain(platformDir, key)));
  }
  return out;
}

/** BROKEN_SUPERSEDE rows for unresolvable or self-referential forward pointers. */
// @spec CHCK-029
export async function supersedesPointerDiagnostics(platformDir: string): Promise<Diagnostic[]> {
  const entries = await collectEntries(platformDir);
  const ids = new Set(entries.map((e) => e.id));
  const rows: Diagnostic[] = [];

  for (const e of entries) {
    if (e.supersedes === null) continue;
    const detail =
      e.supersedes === e.id
        ? `${e.id} declares supersedes on itself`
        : ids.has(e.supersedes)
          ? null
          : `${e.id} supersedes ${e.supersedes} which does not exist`;
    if (detail === null) continue;
    rows.push({
      code: DiagnosticCode.BROKEN_SUPERSEDE,
      severity: "error",
      repo: null,
      source_file: e.sourceFile,
      line: e.line,
      req_id: e.id,
      detail,
    });
  }

  rows.sort(
    (a, b) =>
      (a.source_file ?? "").localeCompare(b.source_file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.req_id ?? "").localeCompare(b.req_id ?? ""),
  );
  return rows;
}
