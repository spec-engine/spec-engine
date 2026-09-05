// packages/engine/src/storage/sqlite.ts
//
// THE ONLY file in the repository allowed to import `bun:sqlite` (D-08).
// All schema work routes through this seam; a future Rust core can swap
// this implementation without touching the rest of the codebase.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  DDL,
  type Domain,
  type DriftRow,
  FILES_MAX,
  type FtsHit,
  type ParseDiagnostic,
  type PropagationRow,
  PropagationState,
  type ProvenanceMatrixRow,
  type ProvenanceRow,
  type RelationRow,
  type Repo,
  type Requirement,
  type RequirementStatus,
  SCHEMA_VERSION,
  type SemanticDiagnostic,
  type Storage,
  type Tag,
  type TermAliasRow,
  type TermCitationRow,
  type WriteHandle,
} from "@spec-engine/shared";
import { rmDbTrio } from "../constants";
import {
  Q1_DANGLING_TAG_SQL,
  Q2_SUPERSEDED_REFERENCED_SQL,
  Q2B_DEPRECATED_REFERENCED_SQL,
  Q2D_DRAFT_REFERENCED_SQL,
  Q3_DRIFT_SQL,
  Q4_ORPHAN_REQ_SQL,
  Q5_UNVERIFIED_REQ_SQL,
  Q6_BROKEN_RELATES_SQL,
  Q7_RELATES_SUPERSEDED_SQL,
  Q8_UNDEFINED_TERM_SQL,
  Q9_ORPHAN_TERM_SQL,
  Q10_TERM_DRIFT_SQL,
  Q11_SUPERSEDED_TERM_REFERENCED_SQL,
} from "./sql/diagnostics";
import {
  FTS_SEARCH_SQL,
  RESOLVE_BY_FILES_SQL_PREFIX,
  RESOLVE_BY_FILES_SQL_SUFFIX,
} from "./sql/fts";
import { PROP_REPO_STATES_SQL } from "./sql/propagation";
import {
  GET_DOMAIN_SQL,
  GET_REPO_SQL,
  GET_REQUIREMENT_SQL,
  LIST_DOMAINS_SQL,
  LIST_PROVENANCE_MATRIX_SQL,
  LIST_PROVENANCE_SQL,
  LIST_RELATIONS_SQL,
  LIST_REPOS_SQL,
  LIST_REQUIREMENTS_SQL_ALL,
  LIST_REQUIREMENTS_SQL_BY_KEY,
  LIST_REQUIREMENTS_SQL_BY_KEY_STATUS,
  LIST_REQUIREMENTS_SQL_BY_STATUS,
  LIST_TAGS_SQL,
  LIST_TERM_ALIASES_SQL,
  LIST_TERM_CITATIONS_SQL,
  PROVENANCE_BY_ISSUE_SQL,
} from "./sql/reads";

/**
 * Read the on-disk schema version, or `null` when `_schema_version` does not
 * exist yet (a fresh DB). Isolated from openStorage so the retry loop reads as
 * a flat version → dispatch flow rather than an inline try/catch.
 */
function readSchemaVersion(db: Database): number | null {
  try {
    const row = db.query("SELECT version FROM _schema_version").get() as {
      version: number;
    } | null;
    return row?.version ?? null;
  } catch {
    // _schema_version table does not exist yet — treat as a fresh DB.
    return null;
  }
}

/**
 * Per-connection lock-wait budget (ms). Without it, any cross-process
 * contention on the derived DB — a `spec serve` reader while `spec check`
 * writes, two parallel `spec` invocations — surfaces as an INSTANT
 * SQLITE_BUSY throw; with it, SQLite retries internally for up to this long
 * before giving up. 2s is far above any real write burst on the index, yet
 * short enough that a genuinely wedged holder still surfaces promptly (the
 * storage/errors.ts classifier turns the eventual SQLITE_BUSY into the
 * "another spec process holds the DB" hint).
 */
export const BUSY_TIMEOUT_MS = 2_000;

/**
 * Schema-version mismatch path: silent rebuild per D-12. Closes the handle,
 * removes the DB file + WAL siblings, asserts none survived, and logs. Factored
 * out of openStorage so its caller's retry loop stays flat; the two-loop
 * remove-then-assert dance is the single most nested part of the rebuild.
 */
function rebuildAfterSchemaMismatch(db: Database, path: string, onDiskVersion: number): void {
  db.close();
  // Use `force: true` to close the TOCTOU window
  // between any existsSync probe and rmSync — a concurrent process
  // (parallel `spec` invocation, build watcher, test runner) deleting
  // the file between check and unlink would otherwise throw ENOENT.
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(path + suffix, { force: true });
  }
  // Assert post-rmSync state so we never silently re-attach to a
  // surviving WAL sibling (which would replay a transaction and
  // resurrect the old _schema_version row → infinite recursion under
  // the prior implementation).
  for (const suffix of ["", "-shm", "-wal"]) {
    if (existsSync(path + suffix)) {
      throw new Error(
        `openStorage: could not remove stale ${path + suffix} during schema-version rebuild`,
      );
    }
  }
  console.error(`note: schema version ${onDiskVersion} != expected ${SCHEMA_VERSION}; rebuilding`);
}

/**
 * Opens (or creates + initializes) a SQLite-backed Storage at `path`.
 *
 * Lifecycle:
 *   - Fresh DB: exec DDL, write SCHEMA_VERSION.
 *   - Existing DB, version matches: no-op (DDL is IF NOT EXISTS everywhere).
 *   - Existing DB, version mismatches: close, delete the file + WAL siblings,
 *     log to stderr, recursively re-open (D-12 silent rebuild).
 *
 * WAL mode (CLAUDE.md mandate): `PRAGMA journal_mode = WAL` is issued
 * explicitly after every fresh-DB open. WAL persists in the file header so
 * subsequent opens inherit it. `synchronous = NORMAL` is the WAL-safe perf
 * companion knob.
 *
 * Schema-mismatch rebuild: the prior implementation recursed without
 * a depth bound, which on a partial rmSync could in theory spin forever.
 * The retry is now an in-function loop with a max-1-retry bound and an
 * explicit post-rmSync assertion that no stale siblings survived.
 */
export function openStorage(path: string): Storage {
  // bun:sqlite's `create: true` creates the file but not its parent. Tests
  // (and CI runs where the gitignored `.spec-engine/` has never been materialized)
  // hit `SQLiteError: unable to open database file` without this guard.
  // CLI commands already mkdir before calling — this makes the storage seam
  // self-sufficient so callers don't have to.
  mkdirSync(dirname(path), { recursive: true });
  // Up to 1 retry after a schema-mismatch silent rebuild — the second open
  // is guaranteed to hit the fresh-DB branch because we asserted the files
  // were removed. Anything beyond that is a deeper FS problem worth
  // surfacing.
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = new Database(path, { create: true, strict: true });
    // Per-connection lock-wait budget — set FIRST, before readSchemaVersion:
    // even that first SELECT can contend with a concurrent writer's
    // exclusive lock (e.g. another `spec` invocation mid-reindex).
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);

    const onDiskVersion = readSchemaVersion(db);

    if (onDiskVersion === null) {
      // Fresh DB path: enable WAL, exec DDL,
      // and write the schema version. WAL pragma must be issued BEFORE the
      // DDL transaction so the journal_mode flag persists into the file
      // header alongside the schema.
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = NORMAL;");
      db.exec(DDL);
      db.run("INSERT INTO _schema_version (version) VALUES (?)", [SCHEMA_VERSION]);
      return new SqliteStorage(path, db);
    }

    if (onDiskVersion !== SCHEMA_VERSION) {
      rebuildAfterSchemaMismatch(db, path, onDiskVersion);
      // Loop back to attempt 1 — now provably reaches the fresh-DB branch.
      continue;
    }

    // Existing-DB path with version match: re-issue the WAL pragma defensively.
    // WAL mode normally persists in the file header, so this is a no-op for
    // already-WAL files; but it covers the case where the file was created
    // by an earlier build that did not set WAL on open.
    //
    // `PRAGMA journal_mode = WAL` is NOT a true no-op on a
    // hot DB — SQLite acquires an exclusive lock to verify/switch journal
    // mode. If `spec query` (read) runs while `spec serve` (long-lived
    // reader) holds the DB open, the unconditional write can contend for
    // the exclusive lock and surface as transient `SQLITE_BUSY`. Read the
    // current journal mode first and only issue the WAL set when needed.
    // `PRAGMA synchronous` is a per-connection setting and stays unconditional.
    const mode = (db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null)
      ?.journal_mode;
    if (mode?.toLowerCase() !== "wal") {
      db.exec("PRAGMA journal_mode = WAL;");
    }
    db.exec("PRAGMA synchronous = NORMAL;");
    return new SqliteStorage(path, db);
  }

  // Should be unreachable: the attempt=1 iteration always hits the fresh-DB
  // branch (assertion above guarantees the rebuild left no stale files).
  throw new Error(
    `openStorage: schema-version rebuild failed to converge after retry (path=${path})`,
  );
}

/**
 * Cold-reset the derived index at `dbPath` — the "never trust a warm index"
 * primitive behind `check --ci`, `gate`, `--fresh`, `supersede`, and MCP.
 *
 * HOW: wipe IN PLACE (DROP every user view + table through the SQLite API)
 * instead of unlinking the file. Unlinking replaced the inode, and a
 * long-lived reader (`spec serve`) kept its open file descriptor on the
 * ghost inode — silently serving stale data forever after every
 * `spec gate` / `spec check --ci` run. The in-place wipe preserves the
 * inode; every DROP commits through the WAL, so live readers observe the
 * wipe + subsequent reindex as ordinary committed transactions. No WAL
 * replay zombies are possible either (the original motivation for the
 * unlink trio): nothing here bypasses the SQLite API, so the -wal sibling
 * is never orphaned from its DB.
 *
 * Dropping `_schema_version` with the rest puts the file on openStorage's
 * fresh-DB branch (readSchemaVersion → null → full DDL + version row), so
 * the post-reset open re-derives everything exactly like a brand-new file —
 * cold-rebuild build_id byte-identity is preserved.
 *
 * FALLBACKS: when the file is absent there is nothing to preserve — remove
 * any orphaned -wal/-shm siblings so stale journal pages cannot contaminate
 * the fresh build. When the file cannot be opened or wiped
 * (corrupt / NOTADB / truncated), unlink the trio: a reader holding a
 * corrupt DB is already broken, and deletion is the only reset that works.
 */
export function coldResetDb(dbPath: string): void {
  if (!existsSync(dbPath)) {
    rmDbTrio(dbPath);
    return;
  }
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { strict: true });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const names = (sql: string): string[] =>
      (db as Database)
        .query(sql)
        .all()
        .map((r) => (r as { name: string }).name);
    // Order matters three ways: views first (they SELECT from tables);
    // virtual tables next (dropping an FTS5 table removes its shadow
    // tables, which SQLite forbids dropping directly — so shadows must
    // never be enumerated as drop targets themselves); ordinary tables
    // last, re-enumerated AFTER the virtual drops so vanished shadows are
    // excluded. Triggers and indexes die with their tables.
    for (const v of names("SELECT name FROM sqlite_master WHERE type = 'view'")) {
      db.exec(`DROP VIEW IF EXISTS ${quote(v)}`);
    }
    for (const t of names(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
    )) {
      db.exec(`DROP TABLE IF EXISTS ${quote(t)}`);
    }
    for (const t of names(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )) {
      db.exec(`DROP TABLE IF EXISTS ${quote(t)}`);
    }
    db.close();
  } catch {
    try {
      db?.close();
    } catch {
      // Handle already closed (or never opened) — nothing to release.
    }
    rmDbTrio(dbPath);
  }
}

/**
 * SqliteStorage — the concrete `Storage` implementation over `bun:sqlite`.
 * Every method is a prepared statement over the derived index; the read
 * methods below are real SELECTs (they were empty stubs in the earliest
 * bring-up, before any surface consumed them).
 */
class SqliteStorage implements Storage {
  readonly path: string;
  readonly #db: Database;

  constructor(path: string, db: Database) {
    this.path = path;
    this.#db = db;
  }

  close(): void {
    this.#db.close();
  }

  // Every read method below is a real prepared SELECT over its table. A
  // method that cannot answer must throw, never return [] or null — an empty
  // result is indistinguishable from "no rows matched" at the call site, so a
  // placeholder returning one silently reports an empty platform.

  /** Real SELECT over `repos`, alphabetic by name. */
  listRepos(): Repo[] {
    return this.#db.query(LIST_REPOS_SQL).all() as Repo[];
  }
  /** Real SELECT over `repos` by name; null if no row
   *  matches. Used by `spec gate` (commands/gate.ts) to read
   *  pinned_spec_version per GATE-01 VERSION_PIN check. */
  getRepo(name: string): Repo | null {
    const row = this.#db.query(GET_REPO_SQL).get({ name }) as Repo | null;
    return row ?? null;
  }
  /** Real SELECT over `domains`, ordered by key. */
  listDomains(): Domain[] {
    return this.#db.query(LIST_DOMAINS_SQL).all() as Domain[];
  }
  /** Real SELECT over `domains` by key; null if no row matches. */
  getDomain(key: string): Domain | null {
    const row = this.#db.query(GET_DOMAIN_SQL).get({ key }) as Domain | null;
    return row ?? null;
  }
  /** Real SELECT over `requirements` with optional
   *  `key` and `status` filters (combined via AND when both are set). The
   *  four (key?, status?) cases are dispatched to four discrete prepared
   *  SQL constants (LIST_REQUIREMENTS_SQL_*) — easier to grep, perf
   *  irrelevant at PoC scale. ORDER BY key, seq for deterministic output. */
  listRequirements(opts?: {
    key?: string | undefined;
    status?: RequirementStatus | undefined;
  }): Requirement[] {
    const key = opts?.key;
    const status = opts?.status;
    if (key !== undefined && status !== undefined) {
      return this.#db
        .query(LIST_REQUIREMENTS_SQL_BY_KEY_STATUS)
        .all({ key, status }) as Requirement[];
    }
    if (key !== undefined) {
      return this.#db.query(LIST_REQUIREMENTS_SQL_BY_KEY).all({ key }) as Requirement[];
    }
    if (status !== undefined) {
      return this.#db.query(LIST_REQUIREMENTS_SQL_BY_STATUS).all({ status }) as Requirement[];
    }
    return this.#db.query(LIST_REQUIREMENTS_SQL_ALL).all() as Requirement[];
  }
  /** Real SELECT over `requirements` by id; null if
   *  no row matches. Used by `/api/requirements/:id`. */
  getRequirement(id: string): Requirement | null {
    const row = this.#db.query(GET_REQUIREMENT_SQL).get({ id }) as Requirement | null;
    return row ?? null;
  }
  /** T7 promotion: real SELECT over `tags` with optional repo / req_id /
   *  file filters (ANDed when combined). Deterministic ORDER BY mirrors the
   *  pipeline's tag insertion sort. */
  listTags(opts?: { repo?: string; req_id?: string; file?: string }): Tag[] {
    return this.#db.query(LIST_TAGS_SQL).all({
      repo: opts?.repo ?? null,
      req_id: opts?.req_id ?? null,
      file: opts?.file ?? null,
    }) as Tag[];
  }
  // --- Prepared SELECTs against the populated DB ---------------------------
  // listDriftRows reads the `drift` VIEW directly (CHCK-03: one predicate, one
  // place). listDiagnostics returns the structural diagnostics persisted by
  // runIndex into parse_diagnostics. coverageMatrix reads the
  // pre-existing `coverage` VIEW; ordering is the member's responsibility
  // (map/format.ts sorts by domain_key → req seq → repo).
  // listSemanticDiagnostics (the UNION of Q1..Q5) lands in Task 3. D-08 keeps
  // SQL in this file.
  //
  // propagationFor: the classifier
  // SQL (PROP_REPO_STATES_SQL above) emits state + via_pred + via_other per
  // member repo; the TS body collapses the two via_* columns into a single
  // `via_req_id` and overlays `drifted` from a SEPARATE `this.listDriftRows()`
  // call. PROP-01 / CHCK-03: the drift predicate is NOT re-derived in
  // PROP_REPO_STATES_SQL — the `drift` VIEW in schema.ts is the only source.

  listDiagnostics(): ParseDiagnostic[] {
    return this.#db
      .query(
        "SELECT id, code, source_file, line, req_id, detail, severity FROM parse_diagnostics ORDER BY code, source_file, line, req_id",
      )
      .all() as ParseDiagnostic[];
  }
  listDriftRows(): DriftRow[] {
    return this.#db
      .query(
        "SELECT repo, req_id, source_file, line, domain_key, req_changed_at_version, repo_pin FROM drift ORDER BY repo, source_file, line, req_id",
      )
      .all() as DriftRow[];
  }
  // Q1..Q5 from 03-RESEARCH § Diagnostic SQL. Each SELECT produces the same
  // column set so concatenation works without reshaping. Ordering inside each
  // query is deterministic; final ordering across the union is the caller's
  // responsibility (the inverted-CI assertion projects + sorts in TS).
  listSemanticDiagnostics(): SemanticDiagnostic[] {
    const rows: SemanticDiagnostic[] = [];
    for (const sql of [
      Q1_DANGLING_TAG_SQL,
      Q2_SUPERSEDED_REFERENCED_SQL,
      Q2B_DEPRECATED_REFERENCED_SQL,
      Q2D_DRAFT_REFERENCED_SQL,
      Q3_DRIFT_SQL,
      Q4_ORPHAN_REQ_SQL,
      Q5_UNVERIFIED_REQ_SQL,
      // RED-16: Relates diagnostics — both warning severity.
      Q6_BROKEN_RELATES_SQL,
      Q7_RELATES_SUPERSEDED_SQL,
      // Term reference-integrity. UNDEFINED_TERM is error
      // (gates --ci); ORPHAN_TERM is warning (a freshly-migrated term is not a
      // defect). The `severity === 'error'` exit predicate in check.ts is
      // untouched — appending here is the ONLY edit needed.
      Q8_UNDEFINED_TERM_SQL,
      Q9_ORPHAN_TERM_SQL,
      // Citation drift. TERM_DRIFT is warning (a
      // lagging pin is a re-confirmation prompt, not a build-breaker);
      // SUPERSEDED_TERM_REFERENCED is error (clone of Q2, gates --ci). The
      // `severity === 'error'` exit predicate in check.ts is untouched —
      // appending here is the ONLY edit needed. Q10 reads the term_drift VIEW,
      // so the drift predicate stays in ONE place (CHCK-03).
      Q10_TERM_DRIFT_SQL,
      Q11_SUPERSEDED_TERM_REFERENCED_SQL,
    ]) {
      const out = this.#db.query(sql).all() as SemanticDiagnostic[];
      for (const r of out) rows.push(r);
    }
    return rows;
  }
  /** RED-16: every Relates link, ordered by (from_id, to_id). */
  listRelations(): RelationRow[] {
    return this.#db.query(LIST_RELATIONS_SQL).all() as RelationRow[];
  }
  /** TERM-01: every glossary-term alias, ordered by (term_id, name). */
  listTermAliases(): TermAliasRow[] {
    return this.#db.query(LIST_TERM_ALIASES_SQL).all() as TermAliasRow[];
  }
  /** TERM-01: every pinned `cites` citation, ordered by the full composite key
   *  (req_id, term_id, cited_as, source_file, line). term_id nullable. */
  listTermCitations(): TermCitationRow[] {
    return this.#db.query(LIST_TERM_CITATIONS_SQL).all() as TermCitationRow[];
  }
  /** PROV-01: every provenance link, ordered by (req_id, role, issue_id). */
  listProvenance(): ProvenanceRow[] {
    return this.#db.query(LIST_PROVENANCE_SQL).all() as ProvenanceRow[];
  }
  /** PMAT-01/04: the widened provenance × coverage matrix, ordered by the full
   *  composite key. issue_id is a projected column only (PROV-02/SC3). */
  provenanceMatrix(): ProvenanceMatrixRow[] {
    return this.#db.query(LIST_PROVENANCE_MATRIX_SQL).all() as ProvenanceMatrixRow[];
  }
  /** PMAT-03: the matrix filtered to one opaque issue id, bound as `$issue` —
   *  never string-interpolated (SC3 / injection-safe). */
  provenanceByIssue(issueId: string): ProvenanceMatrixRow[] {
    return this.#db.query(PROVENANCE_BY_ISSUE_SQL).all({ issue: issueId }) as ProvenanceMatrixRow[];
  }
  coverageMatrix() {
    return this.#db
      .query(
        "SELECT req_id, domain_key, req_status, req_spec_version, req_changed_at_version, repo, repo_pin, implemented, verified, test_levels FROM coverage",
      )
      .all() as ReturnType<Storage["coverageMatrix"]>;
  }
  /**
   * QURY-01 + QURY-02: FTS5 retrieval over the `requirements_fts` virtual
   * table (external-content over `requirements`, `tokenize='porter unicode61'`
   * — porter tokenizer). Column weights are tuned in
   * the prepared SQL (text primary, why half-weight). Results sort by rank
   * ascending per SQLite's negative-multiplier bm25 convention. The rowid
   * JOIN back to `requirements` is mandatory because external-content FTS5
   * stores only the index — column values come from the base table
   * FTS5 grammar errors surface as typed `Error`s (never silently swallowed).
   */
  searchFts(text: string, limit: number = 10): FtsHit[] {
    try {
      return this.#db.query(FTS_SEARCH_SQL).all({ query: text, limit }) as FtsHit[];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Narrow the wrapping to actual FTS5 grammar errors (SQLite
      // reports these with `SQLITE_ERROR` and an `fts5:` / "syntax error"
      // message). Operational errors (database is locked, disk I/O,
      // corruption, OOM) must pass through unchanged so callers aren't
      // misled into chasing a phantom syntax issue.
      if (/fts5:|syntax error/i.test(msg)) {
        throw new Error(`searchFts: FTS5 query syntax error for ${JSON.stringify(text)}: ${msg}`);
      }
      throw e;
    }
  }
  propagationFor(reqId: string): PropagationRow[] {
    const rows = this.#db.query(PROP_REPO_STATES_SQL).all({ target: reqId }) as Array<{
      repo: string;
      state: PropagationState;
      via_pred: string | null;
      via_other: string | null;
    }>;
    // PROP-01: drift overlay is the ONLY drift path. Single listDriftRows()
    // call → O(1) lookup keyed `<repo>:<req_id>`. The drift predicate (the
    // `pin-less-than-changed-at-version` comparison) lives exclusively in
    // the `drift` VIEW DDL in packages/shared/src/schema.ts.
    const driftSet = new Set(this.listDriftRows().map((d) => `${d.repo}:${d.req_id}`));
    return rows.map((r) => {
      const via_req_id =
        r.state === PropagationState.ON_PREDECESSOR
          ? r.via_pred
          : r.state === PropagationState.ON_OTHER_DOMAIN_REQ
            ? r.via_other
            : null;
      // For MIGRATED_*, the drift overlay checks against the target itself;
      // for ON_PREDECESSOR / ON_OTHER_DOMAIN_REQ, against the via id; for
      // NO_DOMAIN_REFERENCE the lookup misses (no tag exists) → drifted=false.
      const driftKey = `${r.repo}:${via_req_id ?? reqId}`;
      return {
        repo: r.repo,
        state: r.state,
        via_req_id,
        drifted: driftSet.has(driftKey),
      };
    });
  }
  /**
   * RSLV-01: Returns the requirements tagged by any file in `files`. The
   * `tags ⨝ requirements` join is the structural answer to "given these
   * source files, which spec requirements do they implement or verify?";
   * DISTINCT collapses the case where a single file's tag plus another
   * file's tag both point at the same requirement (e.g. an `implements`
   * tag in `src/foo.ts` and a `verifies` tag in `test/foo.test.ts` both
   * resolve to BILLING-XXX).
   *
   * Output is sorted deterministically by `(r.key, r.seq)` so callers
   * (the formatter, the HTTP route) never have to re-sort.
   * Empty input short-circuits with no SQL parse cost. Inputs flow through
   * SQLite bind parameters via the spread; the SQL string itself is
   * built from module-scope constants (T-5-01-01: no string concat of
   * caller input into SQL).
   *
   * SQLite's `SQLITE_MAX_VARIABLE_NUMBER` is 32766
   * in Bun's compiled build. PoC inputs are 5-20 paths; v2 may chunk
   * `files` if it ever approaches that ceiling.
   */
  resolveByFiles(files: string[]): Requirement[] {
    if (files.length === 0) return [];
    // Defense-in-depth cap at the storage
    // seam. Both upstream sites (commands/resolve.ts, server/api.ts) already
    // enforce FILES_MAX — but a future caller (new HTTP route, indexer step,
    // webapp feature) could forget. Refuse loudly rather than let the
    // spread blow past SQLITE_MAX_VARIABLE_NUMBER (32766 in Bun's bundled
    // SQLite) and surface as an opaque SQLite error. FILES_MAX is exported
    // from @spec-engine/shared so all three sites share one constant — a future
    // loosening (e.g. bump to 5000) only touches one file.
    //
    // The cap applies to the CALLER's input; the RED-18 self-member
    // expansion below can at most double the bind count (2 × FILES_MAX =
    // 2000), still far under SQLITE_MAX_VARIABLE_NUMBER.
    if (files.length > FILES_MAX) {
      throw new Error(
        `resolveByFiles: too many files (max ${FILES_MAX} per call; got ${files.length})`,
      );
    }
    const queryFiles = this.#expandSelfMemberFiles(files);
    // Self-review hardening: the FILES_MAX guard above caps the CALLER's
    // input, but the bind count is what SQLite actually limits. Today
    // 2 × FILES_MAX = 2000 ≪ 32766; this guard makes that arithmetic a
    // checked invariant instead of a comment, so a future FILES_MAX bump
    // past ~16k fails loudly here rather than as an opaque SQLite error.
    if (queryFiles.length > 32000) {
      throw new Error(
        `resolveByFiles: expanded bind count ${queryFiles.length} would exceed ` +
          "SQLITE_MAX_VARIABLE_NUMBER (32766); lower FILES_MAX",
      );
    }
    const placeholders = queryFiles.map(() => "?").join(",");
    const sql = RESOLVE_BY_FILES_SQL_PREFIX + placeholders + RESOLVE_BY_FILES_SQL_SUFFIX;
    return this.#db.query(sql).all(...queryFiles) as Requirement[];
  }

  /**
   * RED-18: detect the rung-1 self-member from the repos table.
   *
   * In single-repo / rung-1 mode (RUNG1-01) the indexer registers the
   * platform directory ITSELF as the lone member, so `tags.file` carries a
   * `<repo-basename>/<rel>` prefix (e.g. `spec-cli/packages/.../gate.ts`)
   * even though the natural user input from the platform root is the
   * platform-relative `packages/.../gate.ts`. The marker is structural: the
   * self-member is the one repo row whose `path` IS the platform root —
   * i.e. the parent directory of the canonical `spec-engine` row's path. In
   * multi-repo mode every member lives UNDER the platform root
   * (`<platform>/<name>`, discover.ts), so no row can ever match and this
   * returns null — the structural guarantee that multi-repo resolve behavior
   * is unchanged.
   *
   * Derived per call (not cached): `spec serve` reindexes through the same
   * storage handle, and the repos table is rewritten on every index — a
   * cached name could go stale. One indexed point-SELECT is free at PoC scale.
   *
   * Known limitation (mirrors discover.ts ~317-320): a platform directory
   * literally NAMED "spec-engine" registers its self-member row under the
   * colliding name, which the `name != 'spec-engine'` filter below excludes —
   * expansion never fires for that layout. Documented non-goal for the PoC
   * at the discovery layer; recorded here so the two sites stay in sync.
   */
  #selfMemberName(): string | null {
    const canonical = this.getRepo("spec-engine");
    if (!canonical) return null;
    const platformRoot = dirname(canonical.path);
    const row = this.#db
      .query("SELECT name FROM repos WHERE name != 'spec-engine' AND path = $path")
      .get({ path: platformRoot }) as { name: string } | null;
    return row?.name ?? null;
  }

  /**
   * RED-18: in self-member mode, expand each input file with its
   * basename-prefixed variant so BOTH accepted forms hit the IN-clause:
   *
   *   src/orders.ts                      → also try <self>/src/orders.ts
   *   <self>/src/orders.ts               → passed through verbatim
   *
   * Decision per acceptance criterion 2: the prefixed form keeps working
   * (it is what `tags.file` literally stores), the natural form is added.
   * DISTINCT in the SELECT collapses any double-match, so expansion can
   * never duplicate result rows. No self-member → input returned as-is
   * (multi-repo callers pay zero cost beyond one point-SELECT).
   */
  #expandSelfMemberFiles(files: string[]): string[] {
    const self = this.#selfMemberName();
    if (!self) return files;
    const prefix = `${self}/`;
    const expanded = [...files];
    for (const f of files) {
      if (!f.startsWith(prefix)) expanded.push(prefix + f);
    }
    return expanded;
  }

  withWriteTx<T>(fn: (w: WriteHandle) => T): T {
    const wrapped = this.#db.transaction((arg: WriteHandle) => fn(arg));
    return wrapped(this.#makeWriteHandle());
  }

  #makeWriteHandle(): WriteHandle {
    // Prepared statements are created once
    // here and reused across rows by the transaction's caller.
    //
    // D-08 invariant: this is the only file allowed to touch bun:sqlite.
    // strict: true (sqlite.ts:34) means a typo in any $named bind key throws
    // at run time — surfaces wrong-column bugs immediately.
    //
    // BAD_STATUS: `requirements.status` is TEXT NOT NULL with NO
    // CHECK constraint (SCHM-07 / Invariant #4) — bad strings land verbatim so
    // `spec check` can later diagnose them.
    const db = this.#db;

    const insRepo = db.prepare(
      "INSERT OR REPLACE INTO repos (name, path, pinned_spec_version) VALUES ($name, $path, $pin)",
    );
    const insDomain = db.prepare(
      "INSERT OR REPLACE INTO domains (key, owner, schema, spec_version, source_repo) " +
        "VALUES ($key, $owner, $schema, $ver, $source)",
    );
    const insReq = db.prepare(
      "INSERT OR REPLACE INTO requirements " +
        "(id, key, seq, status, superseded_by, text, why, source_file, line, spec_version, changed_at_version, superseded_at_version) " +
        "VALUES ($id, $key, $seq, $status, $sup, $text, $why, $file, $line, $sver, $cver, $saver)",
    );
    // tags / parse_diagnostics use plain INSERT (no OR REPLACE) — every scan
    // run starts from a clearAll'd table and AUTOINCREMENT generates the id.
    const insTag = db.prepare(
      "INSERT INTO tags (req_id, repo, file, line, kind, level) " +
        "VALUES ($req, $repo, $file, $line, $kind, $level)",
    );
    const insDiag = db.prepare(
      "INSERT INTO parse_diagnostics (code, source_file, line, req_id, detail, severity) " +
        "VALUES ($code, $file, $line, $req, $detail, $sev)",
    );
    // RED-16: relations.id is AUTOINCREMENT noise (excluded from build_id);
    // every index run starts from a clearAll'd table.
    const insRelation = db.prepare(
      "INSERT INTO relations (from_id, to_id, source_file, line) " +
        "VALUES ($from, $to, $file, $line)",
    );
    // term_aliases.id / term_citations.id are AUTOINCREMENT
    // noise (excluded from build_id); every index run starts from a clearAll'd
    // table. term_id is bound verbatim (nullable) — no FK, so an unresolved
    // citation lands and is diagnosed at check time (Invariant #4).
    const insTermAlias = db.prepare(
      "INSERT INTO term_aliases (term_id, name) VALUES ($term, $name)",
    );
    const insTermCitation = db.prepare(
      "INSERT INTO term_citations (req_id, term_id, cited_as, pinned_version, source_file, line) " +
        "VALUES ($req, $term, $cited, $pinned, $file, $line)",
    );
    // PROV-01: provenance.id is AUTOINCREMENT noise (excluded from build_id);
    // every index run starts from a clearAll'd table. issue_id is bound as a
    // plain parameterized value — never string-concatenated into the SQL.
    const insProvenance = db.prepare(
      "INSERT INTO provenance (req_id, issue_id, role, source_file, line) " +
        "VALUES ($req, $issue, $role, $file, $line)",
    );

    return {
      clearAll() {
        // Order: children → parents. There are no FKs, but this order also
        // mirrors the FTS5 trigger semantics — DELETE FROM requirements fires
        // requirements_ad per row, keeping requirements_fts in sync.
        for (const tbl of [
          "tags",
          "relations",
          // The two term-store derived tables clear alongside
          // relations/provenance every rebuild (they own nothing — Invariant #1).
          "term_aliases",
          "term_citations",
          "provenance",
          "requirements",
          "domains",
          "repos",
          "parse_diagnostics",
        ]) {
          db.exec(`DELETE FROM ${tbl};`);
        }
        // Reset AUTOINCREMENT so tags.id and parse_diagnostics.id
        // restart at 1 every rebuild. Essential for cold-rebuild determinism
        // even though those id columns are excluded from build_id — without
        // this, subsequent inserts get drifting rowids across runs.
        db.exec("DELETE FROM sqlite_sequence;");
      },
      // Note: under `strict: true`, bun:sqlite expects bind-object keys WITHOUT
      // the leading `$` sigil — the prepared statement's `$name` placeholder is
      // matched against the JS object key `name`. Using `$name` as a JS key
      // throws "Missing parameter \"name\"". Verified against bun 1.3.14.
      upsertRepo(r) {
        insRepo.run({
          name: r.name,
          path: r.path,
          pin: r.pinned_spec_version,
        });
      },
      upsertDomain(d) {
        insDomain.run({
          key: d.key,
          owner: d.owner,
          schema: d.schema,
          ver: d.spec_version,
          source: d.source_repo,
        });
      },
      upsertRequirement(r) {
        insReq.run({
          id: r.id,
          key: r.key,
          seq: r.seq,
          status: r.status,
          sup: r.superseded_by,
          text: r.text,
          why: r.why,
          file: r.source_file,
          line: r.line,
          sver: r.spec_version,
          cver: r.changed_at_version,
          saver: r.superseded_at_version,
        });
      },
      upsertTag(t) {
        insTag.run({
          req: t.req_id,
          repo: t.repo,
          file: t.file,
          line: t.line,
          kind: t.kind,
          level: t.level,
        });
      },
      upsertRelation(r) {
        insRelation.run({
          from: r.from_id,
          to: r.to_id,
          file: r.source_file,
          line: r.line,
        });
      },
      upsertTermAlias(a) {
        insTermAlias.run({
          term: a.term_id,
          name: a.name,
        });
      },
      upsertTermCitation(c) {
        insTermCitation.run({
          req: c.req_id,
          term: c.term_id,
          cited: c.cited_as,
          pinned: c.pinned_version,
          file: c.source_file,
          line: c.line,
        });
      },
      upsertProvenance(p) {
        insProvenance.run({
          req: p.req_id,
          issue: p.issue_id,
          role: p.role,
          file: p.source_file,
          line: p.line,
        });
      },
      recordParseDiagnostic(d) {
        insDiag.run({
          code: d.code,
          file: d.source_file,
          line: d.line,
          req: d.req_id,
          detail: d.detail,
          sev: d.severity,
        });
      },
    };
  }
}

// --- Phase-1-only helpers consumed by the hidden CI smoke subcommands ---
// These live here because D-08 mandates that `bun:sqlite` is touched in
// exactly one file. The smoke subcommands route through these helpers.

/** Inspect sqlite_master and classify objects by kind. FTS5 virtual tables
 *  register as `type='table'` so we look at the `sql` to distinguish them. */
/** The derived schema objects reported by {@link inspectSchema}. */
export interface SchemaInspection {
  tables: string[];
  views: string[];
  virtuals: string[];
  triggers: string[];
}

export function inspectSchema(path: string): SchemaInspection {
  // Wrap in try/finally so the Database handle is released even if
  // the query throws (corrupt file, schema-not-yet-initialized partial
  // write). Matches the listRepoNamesFromDb pattern already established
  // in this file.
  const db = new Database(path);
  try {
    const rows = db.query("SELECT name, type, sql FROM sqlite_master").all() as Array<{
      name: string;
      type: string;
      sql: string | null;
    }>;
    const tables: string[] = [];
    const views: string[] = [];
    const virtuals: string[] = [];
    const triggers: string[] = [];
    for (const r of rows) {
      if (r.name.startsWith("sqlite_")) continue;
      if (r.type === "view") {
        views.push(r.name);
      } else if (r.type === "trigger") {
        triggers.push(r.name);
      } else if (r.type === "table") {
        if (r.sql && /CREATE VIRTUAL TABLE/i.test(r.sql)) {
          virtuals.push(r.name);
        } else {
          tables.push(r.name);
        }
      }
    }
    return { tables, views, virtuals, triggers };
  } finally {
    db.close();
  }
}

/** Overwrite the on-disk `_schema_version` row. Used by the hidden
 *  `__schema-mismatch-smoke` CI command to trigger D-12's silent rebuild. */
export function poisonSchemaVersion(path: string, badVersion: number): void {
  // Release the handle on UPDATE failure (matches the
  // listRepoNamesFromDb pattern).
  const db = new Database(path);
  try {
    db.run("UPDATE _schema_version SET version = ?", [badVersion]);
  } finally {
    db.close();
  }
}

// Test helper. INSERTs a synthetic `repos` row used by
// the cold-rebuild proof test for `spec check --ci`. Kept here per D-08 —
// touches `bun:sqlite`. Mirrors the `poisonSchemaVersion` pattern. The
// injected row is intentionally bogus (`path = "/dev/null"`,
// `pinned_spec_version = 999`) so no real scan input could ever produce it
// — the cold-rebuild test asserts `--ci` wipes it.
/** Insert a synthetic `repos` row that no real scan input could produce.
 *  Used by `check-ci-cold-rebuild.test.ts` to prove `--ci` cold-resets the
 *  full derivation (in-place wipe + re-DDL, not just `DELETE FROM repos`). */
export function poisonRepoRow(path: string, name: string): void {
  // Release the handle on INSERT failure (matches the
  // listRepoNamesFromDb pattern).
  const db = new Database(path);
  try {
    db.run("INSERT INTO repos (name, path, pinned_spec_version) VALUES (?, ?, ?)", [
      name,
      "/dev/null",
      999,
    ]);
  } finally {
    db.close();
  }
}

// Cold-rebuild test helper. Reads `repos.name` directly via a read-only
// Database open — a deliberately independent read path from the SqliteStorage
// class's `listRepos()`, so the test verifies the row contents rather than
// trusting the same code under test. Kept in this file per D-08 (only file
// touching bun:sqlite).
/** Read `repos.name` from the DB at `path`. Used by the cold-rebuild
 *  proof test to verify pre/post-state of the poisoned repos row. */
export function listRepoNamesFromDb(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query("SELECT name FROM repos ORDER BY name").all() as Array<{
      name: string;
    }>;
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

// --- Deterministic build_id helper (INDX-03 / CI-02) ---------------------
//
// computeBuildId(storage) returns a 64-char lowercase hex SHA-256 over a
// canonical SQL projection of the derived index. It lives here (alongside
// inspectSchema / poisonSchemaVersion) — NOT in a separate indexer/buildId.ts
// — because computing the hash requires opening bun:sqlite read-only, and
// D-08 mandates that bun:sqlite is touched in EXACTLY one file. Folding the
// hash here keeps the CI grep-fence green without compromising readability.
//
// Why hash a SQL projection, not the .sqlite file bytes:
//   - SQLite free pages, journal mode, and FTS5 internal layout vary across
//     runs even when row content is identical.
//   - We want byte-identity at the CONTENT level (rows in, rows out), not at
//     the storage layer's representation level.
//
// What is excluded from the projection:
//   - tags.id, parse_diagnostics.id — AUTOINCREMENT noise. clearAll resets
//     sqlite_sequence so they restart at 1, but excluding them removes any
//     ordering coupling between indexer insertion order and the hash.
//
// What guarantees determinism:
//   - Every section has explicit ORDER BY over stable composite keys.
//   - JSON.stringify preserves bun:sqlite's column-order property iteration
//     (ES2015 own-property order matches SELECT column order).
//   - RS (\x1e) + US (\x1f) separators frame sections + rows so that an
//     empty section cannot collide with a populated one.

/**
 * Compute the deterministic build_id for the derived index at `storage.path`.
 *
 * @param storage The Storage handle whose path identifies the DB file. The
 *   function opens a SEPARATE read-only `Database` so it never holds a
 *   writer lock against the caller's open connection.
 * @returns 64-character lowercase hex SHA-256 digest.
 */
export function computeBuildId(storage: Storage): string {
  const db = new Database(storage.path, { readonly: true });
  try {
    const hash = createHash("sha256");

    const sections: Array<{ label: string; sql: string }> = [
      {
        label: "schema_version",
        sql: "SELECT version FROM _schema_version",
      },
      {
        label: "repos",
        sql: "SELECT name, path, pinned_spec_version FROM repos ORDER BY name",
      },
      {
        label: "domains",
        sql: "SELECT key, owner, schema, spec_version, source_repo FROM domains " + "ORDER BY key",
      },
      {
        label: "requirements",
        sql:
          "SELECT id, key, seq, status, superseded_by, text, why, source_file, line, " +
          "spec_version, changed_at_version FROM requirements ORDER BY key, seq",
      },
      {
        label: "tags",
        // tags.id (AUTOINCREMENT) INTENTIONALLY excluded. Sort by the natural
        // composite key so insertion order does not affect the hash.
        sql:
          "SELECT req_id, repo, file, line, kind, level FROM tags " +
          "ORDER BY repo, file, line, req_id",
      },
      {
        label: "relations",
        // relations.id (AUTOINCREMENT) excluded like tags.id. RED-16: the
        // Relates links are part of the derived content, so they MUST hash
        // into build_id for cold-rebuild equivalence to cover them.
        sql:
          "SELECT from_id, to_id, source_file, line FROM relations " +
          "ORDER BY from_id, to_id, source_file, line",
      },
      {
        label: "term_aliases",
        // term_aliases.id (AUTOINCREMENT) excluded like
        // relations.id. The aliases are derived content, so they MUST hash into
        // build_id for cold-rebuild equivalence to cover them. Present-and-empty
        // until Wave C — an empty section still hashes deterministically (the
        // RS/US-framed label alone), so cold-rebuild identity holds now.
        sql: "SELECT term_id, name FROM term_aliases ORDER BY term_id, name",
      },
      {
        label: "term_citations",
        // term_citations.id (AUTOINCREMENT) excluded. The
        // pinned citations are derived content and MUST hash into build_id. The
        // ORDER BY carries the full composite key (req_id, term_id, cited_as,
        // source_file, line) matching LIST_TERM_CITATIONS_SQL and the pipeline
        // pre-sort. Present-and-empty until Wave C.
        sql:
          "SELECT req_id, term_id, cited_as, pinned_version, source_file, line FROM term_citations " +
          "ORDER BY req_id, term_id, cited_as, source_file, line",
      },
      {
        label: "provenance",
        // provenance.id (AUTOINCREMENT) excluded like relations.id. PROV-06:
        // provenance links are derived content and MUST hash into build_id.
        // The build_id hash consumes THIS SQL row order verbatim, so the only
        // requirement is that it be DETERMINISTIC and stable across cold
        // rebuilds — which a fully-specified lexicographic ORDER BY
        // (req_id, role, issue_id, source_file, line) guarantees. This
        // lexicographic SQL order is NOT
        // byte-equal to the formatter's RENDERED order for multi-digit seqs
        // (the formatter's sortProvenance sorts req_id by NUMERIC seq via
        // compareReqIds; SQL sorts it as text). That divergence is fine here
        // because the hash never re-renders through the formatter — it hashes
        // these base rows directly. The provenance_matrix VIEW is NOT hashed
        // (it projects these same base-table rows).
        sql:
          "SELECT req_id, issue_id, role, source_file, line FROM provenance " +
          "ORDER BY req_id, role, issue_id, source_file, line",
      },
      {
        label: "parse_diagnostics",
        // parse_diagnostics.id (AUTOINCREMENT) excluded for the same reason.
        // req_id is included in the projection AND in ORDER BY
        // so the build_id deterministically reflects which requirement each
        // structural diagnostic implicates.
        sql:
          "SELECT code, source_file, line, req_id, detail, severity FROM parse_diagnostics " +
          "ORDER BY code, source_file, line, req_id, detail",
      },
    ];

    for (const { label, sql } of sections) {
      // RS + label + US so the section header cannot collide with row data.
      hash.update(`\x1e${label}\x1f`);
      const rows = db.query(sql).all();
      for (const row of rows) {
        hash.update("\x1e");
        hash.update(JSON.stringify(row));
      }
    }

    return hash.digest("hex");
  } finally {
    // CR-01 (iter2): wrap the body in try/finally so the read-only handle
    // is released even if a row iteration throws (corrupted page, schema
    // mismatch mid-read, JSON.stringify on a non-stringifiable column).
    db.close();
  }
}
