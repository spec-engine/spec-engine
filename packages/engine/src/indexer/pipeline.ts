// packages/engine/src/indexer/pipeline.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INDX-001
// @spec AUTHC-025
//
// PARS-05: the single named `runIndex` function. This is the Rust-swap
// seam — every CLI / webapp / future indexer caller funnels through here,
// and its only DB-side dependency is the typed `Storage` interface from
// @spec-engine/shared. A future Rust core can replace the bun:sqlite-backed
// Storage without touching this file.
//
// INDX-01: composes the platform discovery (discover.ts), the JSON spec
// reader (parser/domainJson.ts), the scanner (scanner/fs.ts +
// scanner/tags.ts), and the structural validator (diagnostics.ts).
//
// INDX-04: every write happens inside ONE storage.withWriteTx call.
// A throw anywhere inside the transaction rolls back the entire DB
// (asserted end-to-end by pipeline.test.ts).
//
// Source pattern: 02-RESEARCH § Pattern 4 (lines 410-498) + 02-PATTERNS
// § indexer/pipeline.ts.
//
// D-08 grep-fence: this file MUST NOT import bun:sqlite. It interacts
// with the DB only through the Storage interface; computeBuildId is
// imported from ../storage/sqlite as a named helper (the named export
// keeps bun:sqlite in exactly one src file).
//
// CLAUDE.md mandate: Bun-native I/O only. File reads go through
// `Bun.file(absPath).text()` — synchronous node-side file reads are
// explicitly avoided here so the indexer plays nicely with bun --compile
// and stays consistent with the scanner/parser layers.

import { basename, dirname, join, resolve } from "node:path";
import type {
  Domain,
  IndexResult,
  ParseDiagnostic,
  ProvenanceRow,
  RelationRow,
  Repo,
  Requirement,
  SkippedRepo,
  Storage,
  Tag,
  TermAliasRow,
  TermCitationRow,
  WriteHandle,
} from "@spec-engine/shared";
import { DiagnosticCode } from "@spec-engine/shared";
import { parseDomainJsonFile } from "../parser/domainJson";
import type { ParsedSpec } from "../parser/types";
import { type DocMention, scanDocFile } from "../scanner/docs";
import { DEFAULT_EXTS, findCodeFiles, findDocFiles, findDomainJsonFiles } from "../scanner/fs";
import { scanTagsInFile } from "../scanner/tags";
import { computeBuildId } from "../storage/sqlite";
import { validateStructure } from "./diagnostics";
import { discoverRepos } from "./discover";

export interface RunIndexOptions {
  platformDir: string;
  storage: Storage;
}

/**
 * Run the full index pipeline against `platformDir`, writing the derived
 * index through `storage` and returning a typed `IndexResult` (PARS-05).
 *
 * Order of operations:
 *   1. Resolve `platformDir` to absolute.
 *   2. discoverRepos → canonical + platformVersion + members.
 *   3. findDomainJsonFiles → parseDomainJsonFile per file → ParsedSpec[]
 *      (JSON is the SOLE spec format post-cutover — D2).
 *   4. findCodeFiles per member → scanTagsInFile per file → Tag[];
 *      findDocFiles per member → scanDocFile → documents-kind Tag[] +
 *      mention candidates (RED-15).
 *   5. validateStructure(specs) → diagnostics[].
 *   6. Sort every collection by stable composite key.
 *   7. ONE withWriteTx call: clearAll + every upsert + every diagnostic.
 *   8. Write doctor.md (ambiguous doc mentions) beside the index DB —
 *      the one deliberate non-Storage side effect (RED-15): a derived
 *      sibling artifact of the DB, best-effort (a write failure warns on
 *      stderr, never fails the committed index). A future Rust core must
 *      reproduce this step alongside the Storage writes.
 *   9. computeBuildId(storage) → return IndexResult.
 *
 * The body is the orchestration seam only: each numbered stage lives in a
 * named module-scope helper (readSpecs / scanMembers / buildRows /
 * writeIndex / finalize) so every function stays ≤15 cognitive complexity.
 */
export async function runIndex(opts: RunIndexOptions): Promise<IndexResult> {
  const platformDir = resolve(opts.platformDir);
  // DISC-02 + DISC-03: `discoverRepos` returns `skipped: SkippedRepo[]` — sibling
  // directories that exist but lack `spec-engine.member.json`. Phase 8 emits one
  // warning-severity NO_SPEC_CONFIG ParseDiagnostic per entry into the pre-sort
  // `diagnostics` array (see `buildRows`), so the row participates in the existing
  // (code, source_file, line, detail) sort and flows into `parse_diagnostics` via
  // the established `recordParseDiagnostic` write path.
  const { canonical, platformVersion, members, skipped } = await discoverRepos(platformDir);

  // Stage 1 — read every SPEC.json through the ONE reader (WR-04: one engine).
  const { specs, structuralDiagnostics } = await readSpecs(canonical);

  // Stage 2 — scan every member for @spec code tags + doc mentions (RED-15).
  const { tagHits, docMentionCandidates } = await scanMembers(members);

  // Stage 3 — build the sorted row layer with byte-identical composite keys.
  const rows = buildRows({
    canonical,
    platformVersion,
    members,
    specs,
    tagHits,
    structuralDiagnostics,
    skipped,
  });

  // Stage 4 — the ONE atomic write (INDX-04).
  writeIndex(opts.storage, rows);

  // Stage 5 — finalize: best-effort doctor.md (RED-15) + build_id hash (WR-03).
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

// --- Stage 1: read every SPEC.json -----------------------------------------

/**
 * Read every SPEC.json under the canonical dir through the ONE reader
 * (WR-04: one engine). Returns the parsed specs plus the structural
 * INVALID_DOMAIN_FILE diagnostics collected along the way.
 *
 * The pipeline calls the SAME `parseDomainJsonFile` the reader unit test
 * exercises — JSON.parse (a non-JSON body is INVALID_DOMAIN_FILE, not a crash
 * — STOR-03) → the ONE structural validator `validateDomainFile` (VAL-02,
 * byte-identical to the write path) → the pure mapper into the UNCHANGED
 * internal rows. Production no longer inlines a forked copy of those three
 * steps, so the test cannot stay green while production diverges. A structural
 * failure contributes ZERO requirements LOUDLY — the em-dash silent-zero is
 * gone. The reader's `Diagnostic.line` (`number | null`) is normalized to the
 * storage `ParseDiagnostic.line` (`number`) at this SINGLE storage boundary
 * via `d.line ?? 0`.
 */
async function readSpecs(
  canonical: Repo,
): Promise<{ specs: ParsedSpec[]; structuralDiagnostics: Omit<ParseDiagnostic, "id">[] }> {
  // D2 (Phase 18): SPEC.json is the SOLE spec format — the Markdown parse
  // path is deleted, so `spec index` reads JSON only.
  const jsonPaths = await findDomainJsonFiles(canonical.path);
  const specs: ParsedSpec[] = [];
  // STOR-03 (17-02): structural INVALID_DOMAIN_FILE rows collected here, merged
  // into `diagnostics` in buildRows BEFORE the sort so they participate in the
  // (code, source_file, line, req_id, detail) ordering (Pitfall 1).
  const structuralDiagnostics: Omit<ParseDiagnostic, "id">[] = [];
  for (const rel of jsonPaths) {
    const absPath = join(canonical.path, rel);
    const text = await Bun.file(absPath).text();
    const platformRelative = `${canonical.name}/${rel}`;
    const fallbackKey = basename(dirname(rel));
    const result = parseDomainJsonFile({ text, sourceFile: platformRelative, fallbackKey });
    if (!result.ok) {
      for (const d of result.diagnostics) {
        structuralDiagnostics.push({
          code: d.code, // always INVALID_DOMAIN_FILE from the reader (STOR-03)
          source_file: d.source_file ?? platformRelative, // platform-relative, NEVER absolute (T-17-04)
          line: d.line ?? 0, // storage boundary: Diagnostic.line (number|null) → ParseDiagnostic.line (number)
          req_id: d.req_id,
          detail: d.detail,
          severity: d.severity,
        });
      }
      continue;
    }
    specs.push(result.spec);
  }
  return { specs, structuralDiagnostics };
}

// --- Stage 2: scan every member for @spec tags ---------------------------

/**
 * Build the per-member extra-ignore list.
 *
 * RUNG1-01 single-repo mode: the self-member IS the platform root, so its
 * code scan must exclude the in-repo `spec-engine/` subfolder — otherwise the
 * canonical SPEC.md dir (and any `.ts` beside it) would be re-ingested as
 * member code (T-gvc-01). Normal members scan exactly as before (default
 * extraIgnore = []). The platform-relative path prefix stays
 * `${member.name}/${rel}` (the basename) for both, so the
 * information-disclosure invariant (T-gvc-02, never the absolute path) holds
 * identically.
 *
 * T7: per-repo `ignore` entries (spec-engine.member.json) join the scan's
 * extra-ignore list, normalized to the scanner's trailing-slash substring
 * contract (`generated` → `generated/`). Additive only — the hardcoded
 * IGNORE_SUBSTR list still applies underneath.
 */
function repoExtraIgnore(member: Repo): string[] {
  const repoIgnore = (member.ignore ?? []).map((e) => (e.endsWith("/") ? e : `${e}/`));
  return [...(member.selfMember ? ["spec-engine/"] : []), ...repoIgnore];
}

/** Scan a single member's code files for `@spec` tags → Omit<Tag,"id">[]. */
async function scanMemberCode(member: Repo, extraIgnore: string[]): Promise<Omit<Tag, "id">[]> {
  const hitsOut: Omit<Tag, "id">[] = [];
  const codePaths = await findCodeFiles(member.path, DEFAULT_EXTS, extraIgnore);
  for (const rel of codePaths) {
    const absPath = join(member.path, rel);
    const text = await Bun.file(absPath).text();
    // Platform-relative file path: `<member.name>/<rel>` (e.g.
    // "api/src/renew.ts"). findCodeFiles returns repo-relative paths;
    // prepending the member name produces the platform-relative form.
    const platformRelative = `${member.name}/${rel}`;
    const hits = scanTagsInFile(member.name, platformRelative, text);
    for (const h of hits) hitsOut.push(h);
  }
  return hitsOut;
}

/**
 * RED-15: scan a single member's documentation (.md) files for explicit
 * `<!-- @spec KEY-NNN -->` bindings (→ documents-kind tags) and for unbound
 * requirement-id mentions (→ doctor.md triage candidates). Same extraIgnore as
 * the code scan so the self-member's in-repo spec-engine/ markdown is never
 * ingested as documentation.
 */
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
    const platformRelative = `${member.name}/${rel}`;
    const { tags, mentions } = scanDocFile(member.name, platformRelative, text);
    for (const t of tags) tagsOut.push(t);
    for (const m of mentions) mentionsOut.push(m);
  }
  return { tags: tagsOut, mentions: mentionsOut };
}

/**
 * Scan every member for @spec tags. Returns the flattened code+doc tag hits
 * and the raw doc mention candidates (RED-15: filtered to known-requirement
 * ids and written to doctor.md by `finalize` after the write tx commits).
 */
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

// --- Stage 3: build the row layer ------------------------------------------

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
  structuralDiagnostics: Omit<ParseDiagnostic, "id">[];
  skipped: SkippedRepo[];
}

/**
 * Build the sorted row layer. Every `sortBy` composite key is BYTE-IDENTICAL to
 * the pre-refactor pipeline (Pitfall 1: structural + NO_SPEC_CONFIG diagnostics
 * are pushed BEFORE the sort). Also returns `flatRequirements` so `finalize` can
 * derive the known-id set without re-flattening.
 */
function buildRows(input: BuildRowsInput): IndexRows {
  const { canonical, platformVersion, members, specs, tagHits, structuralDiagnostics, skipped } =
    input;

  // Repos: canonical (with platformVersion as pin) + every member.
  const sortedRepos: Repo[] = sortBy(
    [
      {
        name: canonical.name,
        path: canonical.path,
        pinned_spec_version: platformVersion,
      } satisfies Repo,
      ...members,
    ],
    (r) => r.name,
  );

  // Domains: one row per ParsedSpec. `source_repo` is always "spec-engine"
  // — the canonical dir owns the spec text.
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

  // Requirements: flatten + sort by (key, seq).
  const flatRequirements: Requirement[] = specs.flatMap((s) => s.requirements);
  const sortedRequirements: Requirement[] = sortBy(
    flatRequirements,
    (r) => `${r.key}\x00${pad(r.seq)}`,
  );

  // Tags: sort by (repo, file, line, req_id).
  const sortedTags: Omit<Tag, "id">[] = sortBy(
    tagHits,
    (t) => `${t.repo}\x00${t.file}\x00${pad(t.line)}\x00${t.req_id}`,
  );

  // Relations (RED-16): flatten per-spec Relates links + sort by the same
  // composite key as the LIST_RELATIONS_SQL / build_id ORDER BY
  // (from_id, to_id) so insertion order is deterministic across rebuilds.
  const sortedRelations: RelationRow[] = sortBy(
    specs.flatMap((s) => s.relations),
    (r) => `${r.from_id}\x00${r.to_id}\x00${r.source_file}\x00${pad(r.line)}`,
  );

  // Term-store collections (TERM-03, Phase 6, Wave C): flatten per-spec
  // term_aliases + resolve the raw citations to term_ids, then pre-sort by the
  // SAME composite keys the LIST_TERM_*_SQL / computeBuildId sections use — so
  // stored insertion order is deterministic and the two build_id sections hash
  // stably across cold rebuilds. Resolution is a platform-wide step (a citation
  // may name a term defined in another spec), so it lives in `buildTermRows`.
  const { sortedTermAliases, sortedTermCitations } = buildTermRows(specs, flatRequirements);

  // Provenance (PROV-06): flatten per-spec Issues links + pre-sort by the
  // same composite key the LIST_PROVENANCE_SQL / computeBuildId provenance
  // section ORDER BY uses (req_id, role, issue_id, source_file, line) — see
  // the cross-ref comment at sqlite.ts computeBuildId provenance section.
  //
  // WR-04 correction: build_id determinism does NOT depend on this JS
  // pre-sort matching the SQL ORDER BY. computeBuildId hashes the SQL
  // projection (the `ORDER BY` above) on BOTH warm and cold runs, and the
  // AUTOINCREMENT `id` is excluded from the hash — so the stored insertion
  // order never feeds build_id. (Earlier comments here claimed the JS key
  // "MUST byte-match" the SQL ORDER BY "or cold-rebuild silently breaks";
  // that overstated the coupling.)
  //
  // What this pre-sort actually buys: tidy, deterministic STORED row order
  // (insertion order matches the canonical query order), which keeps a raw
  // `SELECT * FROM provenance` readable and stable across rebuilds and makes
  // the seen-order intuitive when debugging. Cold-rebuild identity of
  // build_id is guaranteed by the SQL ORDER BY alone. NOTE: the JS key uses
  // UTF-16 code-unit comparison while the SQL ORDER BY uses SQLite BINARY
  // (UTF-8 byte) collation; these diverge only for supplementary-plane code
  // points in issue_id — harmless today since nothing hashes or asserts on
  // the JS-sorted insertion order, only on the SQL projection.
  const sortedProvenance: ProvenanceRow[] = sortBy(
    specs.flatMap((s) => s.provenance),
    (p) => `${p.req_id}\x00${p.role}\x00${p.issue_id}\x00${p.source_file}\x00${pad(p.line)}`,
  );

  // Diagnostics: from validateStructure (structural: DUP_ID/BROKEN_SUPERSEDE/
  // BAD_STATUS, all error-severity) + Phase 8 NO_SPEC_CONFIG emissions
  // (warning-severity, one per skipped sibling — DISC-03 / DISC-04). The
  // resulting array is sorted by (code, source_file, line, req_id, detail) so
  // cold rebuilds produce a deterministic row order (Pitfall 1: push BEFORE
  // sort). The sort key MUST stay aligned with the build_id ORDER BY at
  // sqlite.ts:917 (`ORDER BY code, source_file, line, req_id, detail`) so the
  // pre-sort and the post-write hash projection use identical key ordering.
  // If you add a new diagnostic with a different uniqueness shape, update
  // BOTH sites.
  //
  // Q4 (Phase 18): the index-time broken-file-ref `@`-ref check is RETIRED
  // with the Markdown parse path. The authoring-time `@`-ref check in
  // commands/req.ts (extractRefsFromText / resolveFileRef) still stands.
  const diagnostics: Omit<ParseDiagnostic, "id">[] = validateStructure(specs);
  // STOR-03 (17-02): merge the structural INVALID_DOMAIN_FILE rows collected
  // during the SPEC.json read pass. Pushed BEFORE the sort so they participate
  // in the (code, source_file, line, req_id, detail) ordering (Pitfall 1) and
  // flow through the existing recordParseDiagnostic write path.
  for (const d of structuralDiagnostics) diagnostics.push(d);
  for (const s of skipped) {
    diagnostics.push({
      code: DiagnosticCode.NO_SPEC_CONFIG,
      source_file: s.name, // platform-relative (DISC-04); NEVER the absolute repoPath
      line: 0, // no specific line — row describes a directory
      req_id: null, // no requirement implicated (DISC-03)
      detail: `${s.name}/ has no spec-engine.member.json — run \`spec init ${s.name}\` to include it.`,
      severity: "warning", // first-ever warning-severity emission (DIAG-02)
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
 * TERM-03 (Phase 6, Wave C): flatten + RESOLVE the term-store collections.
 *
 * Aggregates every spec's `term_aliases` into a deterministic name→term_id map
 * (first term_id wins for a name collision — made stable by sorting the alias
 * rows by (term_id, name) FIRST, so "first" never depends on spec scan order,
 * the T-06-08 determinism mitigation) and collects the reserved TERM
 * requirement ids. Then resolves each raw citation's `cited_as`:
 *   1. a known TERM id resolves to ITSELF (citation by id);
 *   2. else the name-map resolves a canonical name / alias (citation by name);
 *   3. else `term_id = null` (Invariant #4 — the row still lands so Wave-D's
 *      UNDEFINED_TERM can fire; NO FK on term_citations, SCHM-07).
 *
 * Pre-sorts both collections by the SAME composite keys the LIST_TERM_*_SQL /
 * computeBuildId sections use, so the stored insertion order is deterministic
 * and the build_id sections hash stably across cold rebuilds.
 * @spec INDX-005
 */
function buildTermRows(
  specs: ParsedSpec[],
  flatRequirements: Requirement[],
): { sortedTermAliases: TermAliasRow[]; sortedTermCitations: TermCitationRow[] } {
  const sortedTermAliases: TermAliasRow[] = sortBy(
    specs.flatMap((s) => s.term_aliases),
    (a) => `${a.term_id}\x00${a.name}`,
  );

  // name→term_id map (first term_id wins for a collision; the (term_id,name)
  // sort above makes "first" deterministic). The reserved TERM id set lets a
  // citation-by-id resolve to itself without a name lookup.
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

// --- Stage 4: the ONE atomic write -----------------------------------------

/**
 * INDX-04: every write happens inside a SINGLE storage.withWriteTx call.
 * A throw anywhere inside this function body rolls back the entire DB (the
 * transaction wrapper inside Storage handles that, asserted end-to-end by
 * pipeline.test.ts). This is the SOLE write transaction in the pipeline — do
 * NOT split writes across multiple transactions.
 */
function writeIndex(storage: Storage, rows: IndexRows): void {
  storage.withWriteTx((w) => {
    w.clearAll();
    for (const r of rows.sortedRepos) w.upsertRepo(r);
    for (const d of rows.sortedDomains) w.upsertDomain(d);
    for (const r of rows.sortedRequirements) w.upsertRequirement(r);
    for (const t of rows.sortedTags) w.upsertTag(t);
    for (const r of rows.sortedRelations) w.upsertRelation(r);
    // TERM-01 (Phase 6): the two term-store collections write inside the SAME
    // single tx (INDX-04) — extracted to keep writeIndex under the cognitive-
    // complexity fence. Empty this wave, populated in Wave C.
    writeTermRows(w, rows);
    for (const p of rows.sortedProvenance) w.upsertProvenance(p);
    for (const d of rows.sortedDiagnostics) w.recordParseDiagnostic(d);
  });
}

/**
 * TERM-01 (Phase 6): write the two term-store collections. Split out of
 * `writeIndex` so that function stays under the noExcessiveCognitiveComplexity
 * fence; called INSIDE the same withWriteTx (INDX-04 — one atomic write).
 * Empty this wave; the aliases/cites flatten lands in Wave C.
 */
function writeTermRows(w: WriteHandle, rows: IndexRows): void {
  for (const a of rows.sortedTermAliases) w.upsertTermAlias(a);
  for (const c of rows.sortedTermCitations) w.upsertTermCitation(c);
}

// --- Stage 5: finalize (doctor.md + build_id) ------------------------------

interface FinalizeInput {
  storage: Storage;
  docMentionCandidates: DocMention[];
  flatRequirements: Requirement[];
}

/**
 * Best-effort doctor.md write (RED-15) + build_id hash (WR-03). Runs AFTER the
 * write tx commits; returns the computed build_id.
 */
async function finalize(input: FinalizeInput): Promise<string> {
  const { storage, docMentionCandidates, flatRequirements } = input;

  // --- RED-15: doctor.md ambiguity triage --------------------------------
  // Mentions filtered to KNOWN requirement ids only — issue-tracker refs
  // (JIRA-123) and prose examples with made-up ids never surface. The file
  // is a derived artifact written BESIDE the index DB (dirname of
  // storage.path, normally `.spec-engine/`), so committed fixture trees indexed
  // with an external DB path are never polluted, and deleting it is always
  // safe. Written AFTER the tx commits so a rolled-back index never leaves
  // a doctor.md inconsistent with the DB; content is deterministic
  // (sorted by file, line, req_id) per the cold-rebuild equivalence rule.
  const knownIds = new Set(flatRequirements.map((r) => r.id));
  const ambiguous = sortBy(
    docMentionCandidates.filter((m) => knownIds.has(m.req_id)),
    (m) => `${m.file}\x00${pad(m.line)}\x00${m.req_id}`,
  );
  const doctorPath = join(dirname(storage.path), "doctor.md");
  // Self-review hardening (mirrors the computeBuildId guard below): the tx
  // has already committed, so a failed side-report write must NOT crash the
  // run and mask a perfectly valid index. doctor.md is advisory triage —
  // degrade to a stderr warning and keep going. (computeBuildId rethrows
  // instead because callers depend on build_id; nobody branches on doctor.md.)
  try {
    await Bun.write(doctorPath, renderDoctorMd(ambiguous));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`spec index: warning: could not write ${doctorPath}: ${detail}`);
  }

  // --- Compute build_id over the committed projection -------------------
  // WR-03: computeBuildId opens a SEPARATE read-only Database connection.
  // If that secondary open throws (e.g. FS pressure, AV scanner holding the
  // file on darwin), the write transaction has already committed — the
  // index is valid on disk but the caller never sees a build_id. Catch and
  // rethrow with a clear message that distinguishes "write succeeded, hash
  // failed" from the more typical "write failed" path, so the operator can
  // diagnose without grepping the source.
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

// --- Helpers ----------------------------------------------------------------

/** Pad a non-negative integer to a fixed width so lexicographic sort
 *  matches numeric sort. 10 digits covers numbers up to 9,999,999,999. */
function pad(n: number): string {
  return n.toString().padStart(10, "0");
}

/** Stable sort returning a NEW array (does not mutate input). */
function sortBy<T>(arr: readonly T[], keyFn: (x: T) => string): T[] {
  return [...arr].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * RED-15: render the doctor.md triage report. Pure string assembly over an
 * ALREADY-SORTED ambiguity list — determinism is the caller's contract.
 * Each entry is a doc line that mentions a known requirement id without an
 * explicit `<!-- @spec ID -->` binding on that line.
 */
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
