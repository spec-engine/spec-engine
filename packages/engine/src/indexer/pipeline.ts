// @spec INDX-007
//
// Every caller funnels through `runIndex`, whose only DB dependency is the
// `Storage` interface, so a different storage core can replace the
// bun:sqlite one without touching this file. This file must not import
// bun:sqlite (scripts/arch-fences.sh); computeBuildId is a named export of
// ../storage/sqlite for that reason.
//
// File reads use `Bun.file(...).text()`, not node's sync reads, so the
// indexer survives `bun --compile`.

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  Domain,
  IndexResult,
  ParseDiagnostic,
  ProvenanceRow,
  RelationRow,
  Repo,
  Requirement,
  Storage,
  Tag,
  TermAliasRow,
  TermCitationRow,
  WriteHandle,
} from "@spec-engine/shared";
import { type Diagnostic, DiagnosticCode, InvalidDomainFilesError } from "@spec-engine/shared";
import { parseDomainJsonFile } from "../parser/domainJson";
import type { ParsedSpec } from "../parser/types";
import { type DocMention, scanDocFile } from "../scanner/docs";
import {
  DEFAULT_EXTS,
  findCodeFiles,
  findDocFiles,
  findDomainJsonFiles,
  isDocSource,
  isHiddenPath,
  isPathIgnored,
  isTagSource,
} from "../scanner/fs";
import { scanTagsInFile } from "../scanner/tags";
import { computeBuildId } from "../storage/sqlite";
import { validateStructure } from "./diagnostics";
import { discoverRepos, type NamedDir, type PlatformDiagnostic } from "./discover";

export interface RunIndexOptions {
  platformDir: string;
  storage: Storage;
}

/**
 * doctor.md, written by `finalize` beside the index DB, is the one side
 * effect outside `Storage`; a replacement storage core must reproduce it.
 */
export async function runIndex(opts: RunIndexOptions): Promise<IndexResult> {
  const platformDir = resolve(opts.platformDir);
  const {
    canonical,
    platformVersion,
    members,
    unpinned,
    diagnostics: platformDiagnostics,
  } = await discoverRepos(platformDir);

  const specs = await readSpecs(canonical);
  const { tagHits, docMentionCandidates } = await scanMembers(members);
  const rows = buildRows({
    canonical,
    platformVersion,
    members,
    specs,
    tagHits,
    unpinned,
    platformDiagnostics,
  });
  writeIndex(opts.storage, rows);
  const build_id = await finalize({
    storage: opts.storage,
    docMentionCandidates,
    flatRequirements: rows.flatRequirements,
  });

  return {
    build_id,
    repos: rows.sortedRepos.length,
    domains: rows.sortedDomains.length,
    requirements: rows.sortedRequirements.length,
    tags: rows.sortedTags.length,
    diagnostics: rows.sortedDiagnostics.length,
  };
}

/**
 * Every file is parsed before any refusal, so one run
 * reports every invalid file; the throw lands before `writeIndex`, so the
 * index on disk is left as it was.
 * @spec INDX-016
 */
async function readSpecs(canonical: Repo): Promise<ParsedSpec[]> {
  const jsonPaths = await findDomainJsonFiles(canonical.path);
  const specs: ParsedSpec[] = [];
  const invalid: Diagnostic[] = [];
  for (const rel of jsonPaths) {
    const absPath = join(canonical.path, rel);
    const text = await Bun.file(absPath).text();
    const platformRelative = `${canonical.name}/${rel}`;
    const fallbackKey = basename(dirname(rel));
    const result = parseDomainJsonFile({ text, sourceFile: platformRelative, fallbackKey });
    if (result.ok) specs.push(result.spec);
    else
      for (const d of result.diagnostics)
        invalid.push({ ...d, source_file: d.source_file ?? platformRelative });
  }
  if (invalid.length > 0) throw new InvalidDomainFilesError(invalid);
  return specs;
}

/**
 * A self-member is the platform root, so its scan excludes the in-repo
 * `spec-engine/` folder, else the canonical spec dir is ingested as member
 * code. Per-repo `ignore` entries get the trailing slash the scanner's
 * substring match needs (`generated` → `generated/`); they add to
 * IGNORE_SUBSTR, never replace it.
 */
function repoExtraIgnore(member: Repo): string[] {
  const repoIgnore = (member.ignore ?? []).map((e) => (e.endsWith("/") ? e : `${e}/`));
  return [...(member.selfMember ? ["spec-engine/"] : []), ...repoIgnore];
}

/**
 * The `tags.file` key of the platform-relative path `platformRel` when a
 * member scan reads it, else null. The deepest member holding the path owns
 * it: a monorepo's root column ignores its package directories.
 */
export function scannedTagFile(
  members: readonly Repo[],
  platformDir: string,
  platformRel: string,
): string | null {
  const abs = resolve(platformDir, platformRel);
  let owner: { member: Repo; rel: string } | null = null;
  for (const member of members) {
    const rel = relative(member.path, abs).split(sep).join("/");
    if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) continue;
    if (owner === null || member.path.length > owner.member.path.length) owner = { member, rel };
  }
  if (owner === null) return null;
  const { member, rel } = owner;
  if (isHiddenPath(rel) || isPathIgnored(rel, repoExtraIgnore(member))) return null;
  if (!isTagSource(rel) && !isDocSource(rel)) return null;
  return tagFile(member, rel);
}

/** Platform-relative: a lone repository is the platform, so its column name is no path inside it. */
function tagFile(member: Repo, rel: string): string {
  return member.selfMember ? rel : `${member.name}/${rel}`;
}

async function scanMemberCode(member: Repo, extraIgnore: string[]): Promise<Omit<Tag, "id">[]> {
  const hitsOut: Omit<Tag, "id">[] = [];
  const codePaths = await findCodeFiles(member.path, DEFAULT_EXTS, extraIgnore);
  for (const rel of codePaths) {
    const absPath = join(member.path, rel);
    const text = await Bun.file(absPath).text();
    const platformRelative = tagFile(member, rel);
    const hits = scanTagsInFile(member.name, platformRelative, text);
    for (const h of hits) hitsOut.push(h);
  }
  return hitsOut;
}

async function scanMemberDocs(
  member: Repo,
  extraIgnore: string[],
): Promise<{ tags: Omit<Tag, "id">[]; mentions: DocMention[] }> {
  const tagsOut: Omit<Tag, "id">[] = [];
  const mentionsOut: DocMention[] = [];
  const docPaths = await findDocFiles(member.path, extraIgnore);
  for (const rel of docPaths) {
    const absPath = join(member.path, rel);
    const text = await Bun.file(absPath).text();
    const platformRelative = tagFile(member, rel);
    const { tags, mentions } = scanDocFile(member.name, platformRelative, text);
    for (const t of tags) tagsOut.push(t);
    for (const m of mentions) mentionsOut.push(m);
  }
  return { tags: tagsOut, mentions: mentionsOut };
}

async function scanMembers(
  members: Repo[],
): Promise<{ tagHits: Omit<Tag, "id">[]; docMentionCandidates: DocMention[] }> {
  const tagHits: Omit<Tag, "id">[] = [];
  const docMentionCandidates: DocMention[] = [];
  for (const member of members) {
    const extraIgnore = repoExtraIgnore(member);
    const codeHits = await scanMemberCode(member, extraIgnore);
    for (const h of codeHits) tagHits.push(h);
    const { tags, mentions } = await scanMemberDocs(member, extraIgnore);
    for (const t of tags) tagHits.push(t);
    for (const m of mentions) docMentionCandidates.push(m);
  }
  return { tagHits, docMentionCandidates };
}

interface IndexRows {
  sortedRepos: Repo[];
  sortedDomains: Domain[];
  sortedRequirements: Requirement[];
  sortedTags: Omit<Tag, "id">[];
  sortedRelations: RelationRow[];
  sortedTermAliases: TermAliasRow[];
  sortedTermCitations: TermCitationRow[];
  sortedProvenance: ProvenanceRow[];
  sortedDiagnostics: Omit<ParseDiagnostic, "id">[];
  flatRequirements: Requirement[];
}

interface BuildRowsInput {
  canonical: Repo;
  platformVersion: number;
  members: Repo[];
  specs: ParsedSpec[];
  tagHits: Omit<Tag, "id">[];
  /** Declared members without a pin: one NO_SPEC_CONFIG row each. */
  unpinned: NamedDir[];
  /** platform-map's diagnostics, already reduced to the ones `spec check` surfaces. */
  platformDiagnostics: PlatformDiagnostic[];
}

/**
 * Each `sortBy` key matches the ORDER BY of the matching LIST_*_SQL and
 * computeBuildId section, so stored insertion order equals query order.
 */
function buildRows(input: BuildRowsInput): IndexRows {
  const { canonical, platformVersion, members, specs, tagHits, unpinned, platformDiagnostics } =
    input;

  const sortedRepos: Repo[] = sortBy(
    [
      {
        name: canonical.name,
        path: canonical.path,
        pinned_spec_version: platformVersion,
        dependency_depth: 0,
      } satisfies Repo,
      ...members,
    ],
    (r) => r.name,
  );

  const sortedDomains: Domain[] = sortBy(
    specs.map(
      (s) =>
        ({
          key: s.key,
          owner: s.owner,
          schema: s.schema,
          spec_version: s.spec_version,
          source_repo: canonical.name,
        }) satisfies Domain,
    ),
    (d) => d.key,
  );

  const flatRequirements: Requirement[] = specs.flatMap((s) => s.requirements);
  const sortedRequirements: Requirement[] = sortBy(
    flatRequirements,
    (r) => `${r.key}\x00${pad(r.seq)}`,
  );

  const sortedTags: Omit<Tag, "id">[] = sortBy(
    tagHits,
    (t) => `${t.repo}\x00${t.file}\x00${pad(t.line)}\x00${t.req_id}`,
  );

  const sortedRelations: RelationRow[] = sortBy(
    specs.flatMap((s) => s.relations),
    (r) => `${r.from_id}\x00${r.to_id}\x00${r.source_file}\x00${pad(r.line)}`,
  );

  // A citation may name a term defined in another spec, so resolution runs
  // over every spec at once.
  const { sortedTermAliases, sortedTermCitations } = buildTermRows(specs, flatRequirements);

  // build_id does not depend on these JS pre-sorts: computeBuildId hashes the
  // SQL projection's ORDER BY and excludes the AUTOINCREMENT id. The JS key
  // compares UTF-16 code units where SQLite BINARY compares UTF-8 bytes; they
  // diverge only for supplementary-plane code points, which is harmless while
  // nothing hashes the stored insertion order.
  const sortedProvenance: ProvenanceRow[] = sortBy(
    specs.flatMap((s) => s.provenance),
    (p) => `${p.req_id}\x00${p.role}\x00${p.issue_id}\x00${p.source_file}\x00${pad(p.line)}`,
  );

  // Every diagnostics row is pushed before the one sort.
  const diagnostics: Omit<ParseDiagnostic, "id">[] = validateStructure(specs);
  // @spec INIT-032
  for (const s of unpinned) {
    diagnostics.push({
      code: DiagnosticCode.NO_SPEC_CONFIG,
      source_file: s.name,
      line: 0,
      req_id: null,
      detail: `${s.name}/ has no spec-engine.member.json — run \`spec init ${s.name}\` to include it.`,
      severity: "warning",
    });
  }
  // @spec CHCK-055
  for (const d of platformDiagnostics) {
    diagnostics.push({
      code: d.code,
      source_file: d.subject,
      line: 0,
      req_id: null,
      detail: d.detail,
      severity: d.severity,
    });
  }
  const sortedDiagnostics: Omit<ParseDiagnostic, "id">[] = sortBy(
    diagnostics,
    (d) => `${d.code}\x00${d.source_file}\x00${pad(d.line)}\x00${d.req_id ?? ""}\x00${d.detail}`,
  );

  return {
    sortedRepos,
    sortedDomains,
    sortedRequirements,
    sortedTags,
    sortedRelations,
    sortedTermAliases,
    sortedTermCitations,
    sortedProvenance,
    sortedDiagnostics,
    flatRequirements,
  };
}

/**
 * An unresolved citation keeps `term_id = null` and still lands, so
 * UNDEFINED_TERM can fire; term_citations has no FK for that reason.
 * @spec INDX-012
 */
function buildTermRows(
  specs: ParsedSpec[],
  flatRequirements: Requirement[],
): { sortedTermAliases: TermAliasRow[]; sortedTermCitations: TermCitationRow[] } {
  const sortedTermAliases: TermAliasRow[] = sortBy(
    specs.flatMap((s) => s.term_aliases),
    (a) => `${a.term_id}\x00${a.name}`,
  );

  // First term_id wins a name collision; the (term_id, name) sort above keeps
  // "first" independent of spec scan order.
  const nameToTermId = new Map<string, string>();
  for (const a of sortedTermAliases) {
    if (!nameToTermId.has(a.name)) nameToTermId.set(a.name, a.term_id);
  }
  const termReqIds = new Set(flatRequirements.filter((r) => r.key === "TERM").map((r) => r.id));

  const resolved: TermCitationRow[] = specs.flatMap((s) =>
    s.term_citations.map((c) => ({
      req_id: c.req_id,
      term_id: termReqIds.has(c.cited_as) ? c.cited_as : (nameToTermId.get(c.cited_as) ?? null),
      cited_as: c.cited_as,
      pinned_version: c.pinned_version,
      source_file: c.source_file,
      line: c.line,
    })),
  );
  const sortedTermCitations: TermCitationRow[] = sortBy(
    resolved,
    (c) =>
      `${c.req_id}\x00${c.term_id ?? ""}\x00${c.cited_as ?? ""}\x00${c.source_file}\x00${pad(c.line)}`,
  );

  return { sortedTermAliases, sortedTermCitations };
}

/**
 * The sole write transaction: a throw anywhere inside rolls back the whole
 * DB. Do not split writes across transactions.
 */
function writeIndex(storage: Storage, rows: IndexRows): void {
  storage.withWriteTx((w) => {
    w.clearAll();
    for (const r of rows.sortedRepos) w.upsertRepo(r);
    for (const d of rows.sortedDomains) w.upsertDomain(d);
    for (const r of rows.sortedRequirements) w.upsertRequirement(r);
    for (const t of rows.sortedTags) w.upsertTag(t);
    for (const r of rows.sortedRelations) w.upsertRelation(r);
    writeTermRows(w, rows);
    for (const p of rows.sortedProvenance) w.upsertProvenance(p);
    for (const d of rows.sortedDiagnostics) w.recordParseDiagnostic(d);
  });
}

/** Split out of `writeIndex` for biome's cognitive-complexity limit; runs inside its transaction. */
function writeTermRows(w: WriteHandle, rows: IndexRows): void {
  for (const a of rows.sortedTermAliases) w.upsertTermAlias(a);
  for (const c of rows.sortedTermCitations) w.upsertTermCitation(c);
}

interface FinalizeInput {
  storage: Storage;
  docMentionCandidates: DocMention[];
  flatRequirements: Requirement[];
}

/** Runs after the write transaction commits, so a rolled-back index never leaves a stale doctor.md. */
async function finalize(input: FinalizeInput): Promise<string> {
  const { storage, docMentionCandidates, flatRequirements } = input;

  // Known ids only, so tracker refs (JIRA-123) and made-up prose ids never
  // surface. Written beside the DB, not the platform, so a fixture tree
  // indexed with an external DB path is never polluted.
  const knownIds = new Set(flatRequirements.map((r) => r.id));
  const ambiguous = sortBy(
    docMentionCandidates.filter((m) => knownIds.has(m.req_id)),
    (m) => `${m.file}\x00${pad(m.line)}\x00${m.req_id}`,
  );
  const doctorPath = join(dirname(storage.path), "doctor.md");
  // The index is already committed and doctor.md is advisory, so a failed
  // write only warns. computeBuildId below rethrows because callers depend
  // on build_id.
  try {
    await Bun.write(doctorPath, renderDoctorMd(ambiguous));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`spec index: warning: could not write ${doctorPath}: ${detail}`);
  }

  // computeBuildId opens a separate read-only connection, which can fail
  // after the write committed (an AV scanner holding the file on darwin);
  // the rethrow says the index on disk is intact.
  let build_id: string;
  try {
    build_id = computeBuildId(storage);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `runIndex: write transaction committed but build_id hashing failed (${detail}). ` +
        "The derived index is intact on disk; re-running 'spec index' will recompute the hash.",
    );
  }

  return build_id;
}

/** Fixed width so lexicographic sort matches numeric sort. */
function pad(n: number): string {
  return n.toString().padStart(10, "0");
}

function sortBy<T>(arr: readonly T[], keyFn: (x: T) => string): T[] {
  return [...arr].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Does not sort: the caller passes `ambiguous` already sorted. */
function renderDoctorMd(ambiguous: readonly DocMention[]): string {
  const header = [
    "# Spec Engine doc triage — ambiguous requirement mentions",
    "",
    "Derived artifact, regenerated by every `spec index`. Never authored —",
    "deleting it is safe; it returns on the next index.",
    "",
    "Each entry is a documentation line that mentions a known requirement id",
    "WITHOUT an explicit `<!-- @spec ID -->` binding on the same line. Either",
    "bind the line so requirement changes surface it (`spec check`), or",
    "rephrase so the mention is clearly incidental.",
    "",
  ];
  if (ambiguous.length === 0) {
    return [...header, "No ambiguous mentions found.", ""].join("\n");
  }
  const entries = ambiguous.map((m) => `- ${m.file}:${m.line} — ${m.req_id} — "${m.text}"`);
  return [...header, ...entries, ""].join("\n");
}
