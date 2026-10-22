// The only file allowed to import `bun:sqlite` (fence_d08_engine_internal).
// Anything that needs the driver, including test helpers, lives here.

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
  quoteBareWords,
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

/** `null` when `_schema_version` does not exist yet: a fresh DB. */
function readSchemaVersion(db: Database): number | null {
  try {
    const row = db.query("SELECT version FROM _schema_version").get() as {
      version: number;
    } | null;
    return row?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Without a busy timeout any cross-process contention (a `spec serve` reader
 * while `spec check` writes) throws SQLITE_BUSY instantly. 2s is far above
 * any real write burst on the index, yet short enough that a wedged holder
 * still surfaces promptly.
 */
export const BUSY_TIMEOUT_MS = 2_000;

function rebuildAfterSchemaMismatch(db: Database, path: string, onDiskVersion: number): void {
  db.close();
  // `force: true` rather than an existsSync probe: a concurrent process may
  // delete the file between the check and the unlink.
  for (const suffix of ["", "-shm", "-wal"]) {
    rmSync(path + suffix, { force: true });
  }
  // A surviving WAL sibling would replay a transaction and resurrect the old
  // _schema_version row, so the reopen must never attach to one.
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
 * A schema-version mismatch deletes the file and its WAL siblings and reopens
 * fresh. The retry is bounded at one: the rebuild asserts no sibling
 * survived, so a second mismatch is a deeper filesystem problem.
 */
export function openStorage(path: string): Storage {
  // bun:sqlite's `create: true` creates the file but not its parent.
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = new Database(path, { create: true, strict: true });
    // First, before readSchemaVersion: even that SELECT can contend with a
    // concurrent writer's exclusive lock.
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);

    const onDiskVersion = readSchemaVersion(db);

    if (onDiskVersion === null) {
      // WAL before the DDL so the journal_mode flag persists into the file
      // header alongside the schema.
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = NORMAL;");
      db.exec(DDL);
      db.run("INSERT INTO _schema_version (version) VALUES (?)", [SCHEMA_VERSION]);
      return new SqliteStorage(path, db);
    }

    if (onDiskVersion !== SCHEMA_VERSION) {
      rebuildAfterSchemaMismatch(db, path, onDiskVersion);
      continue;
    }

    // Read the journal mode before setting it: `PRAGMA journal_mode = WAL`
    // takes an exclusive lock even when already in WAL, and contends with a
    // long-lived `spec serve` reader. `synchronous` is per-connection, so it
    // stays unconditional.
    const mode = (db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null)
      ?.journal_mode;
    if (mode?.toLowerCase() !== "wal") {
      db.exec("PRAGMA journal_mode = WAL;");
    }
    db.exec("PRAGMA synchronous = NORMAL;");
    return new SqliteStorage(path, db);
  }

  throw new Error(
    `openStorage: schema-version rebuild failed to converge after retry (path=${path})`,
  );
}

/**
 * Wipes in place (DROP every view and table through the SQLite API) rather
 * than unlinking: unlinking replaces the inode, and a long-lived reader
 * (`spec serve`) would keep its fd on the ghost file and serve stale data
 * forever. Every DROP commits through the WAL, so live readers see the wipe
 * and reindex as ordinary transactions. Dropping `_schema_version` too puts
 * the next open on the fresh-DB branch, so build_id stays byte-identical.
 *
 * An absent file still gets its orphaned -wal/-shm removed. A file that cannot
 * be opened or wiped (corrupt, NOTADB) is unlinked: a reader holding it is
 * already broken.
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
    // Order matters: views first (they SELECT from tables); then virtual
    // tables, whose drop removes FTS5 shadow tables SQLite forbids dropping
    // directly; then ordinary tables, enumerated only after the virtual drops
    // so vanished shadows are excluded. Triggers and indexes die with tables.
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
      // Already closed or never opened.
    }
    rmDbTrio(dbPath);
  }
}

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

  listRepos(): Repo[] {
    return this.#db.query(LIST_REPOS_SQL).all() as Repo[];
  }
  getRepo(name: string): Repo | null {
    const row = this.#db.query(GET_REPO_SQL).get({ name }) as Repo | null;
    return row ?? null;
  }
  listDomains(): Domain[] {
    return this.#db.query(LIST_DOMAINS_SQL).all() as Domain[];
  }
  getDomain(key: string): Domain | null {
    const row = this.#db.query(GET_DOMAIN_SQL).get({ key }) as Domain | null;
    return row ?? null;
  }
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
  getRequirement(id: string): Requirement | null {
    const row = this.#db.query(GET_REQUIREMENT_SQL).get({ id }) as Requirement | null;
    return row ?? null;
  }
  listTags(opts?: { repo?: string; req_id?: string; file?: string }): Tag[] {
    return this.#db.query(LIST_TAGS_SQL).all({
      repo: opts?.repo ?? null,
      req_id: opts?.req_id ?? null,
      file: opts?.file ?? null,
    }) as Tag[];
  }

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
  /** Each query is ordered; ordering across the concatenation is the caller's. */
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
      Q6_BROKEN_RELATES_SQL,
      Q7_RELATES_SUPERSEDED_SQL,
      Q8_UNDEFINED_TERM_SQL,
      Q9_ORPHAN_TERM_SQL,
      Q10_TERM_DRIFT_SQL,
      Q11_SUPERSEDED_TERM_REFERENCED_SQL,
    ]) {
      const out = this.#db.query(sql).all() as SemanticDiagnostic[];
      for (const r of out) rows.push(r);
    }
    return rows;
  }
  listRelations(): RelationRow[] {
    return this.#db.query(LIST_RELATIONS_SQL).all() as RelationRow[];
  }
  listTermAliases(): TermAliasRow[] {
    return this.#db.query(LIST_TERM_ALIASES_SQL).all() as TermAliasRow[];
  }
  listTermCitations(): TermCitationRow[] {
    return this.#db.query(LIST_TERM_CITATIONS_SQL).all() as TermCitationRow[];
  }
  listProvenance(): ProvenanceRow[] {
    return this.#db.query(LIST_PROVENANCE_SQL).all() as ProvenanceRow[];
  }
  provenanceMatrix(): ProvenanceMatrixRow[] {
    return this.#db.query(LIST_PROVENANCE_MATRIX_SQL).all() as ProvenanceMatrixRow[];
  }
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
  searchFts(text: string, limit: number = 10): FtsHit[] {
    try {
      return this.#db.query(FTS_SEARCH_SQL).all({ query: quoteBareWords(text), limit }) as FtsHit[];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Only grammar errors are rewrapped. Operational errors (locked, I/O,
      // corruption) pass through unchanged so nobody chases a phantom syntax
      // issue.
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
    // The drift predicate lives only in the `drift` view (schema.ts); it is
    // overlaid here, never re-derived in PROP_REPO_STATES_SQL.
    const driftSet = new Set(this.listDriftRows().map((d) => `${d.repo}:${d.req_id}`));
    return rows.map((r) => {
      const via_req_id =
        r.state === PropagationState.ON_PREDECESSOR
          ? r.via_pred
          : r.state === PropagationState.ON_OTHER_DOMAIN_REQ
            ? r.via_other
            : null;
      // NO_DOMAIN_REFERENCE has no tag, so its lookup misses: drifted=false.
      const driftKey = `${r.repo}:${via_req_id ?? reqId}`;
      return {
        repo: r.repo,
        state: r.state,
        via_req_id,
        drifted: driftSet.has(driftKey),
      };
    });
  }
  resolveByFiles(files: string[]): Requirement[] {
    if (files.length === 0) return [];
    // The upstream callers already enforce FILES_MAX; this repeats it at the
    // seam so a new caller cannot blow past SQLITE_MAX_VARIABLE_NUMBER (32766
    // in Bun's bundled SQLite) and surface an opaque SQLite error.
    if (files.length > FILES_MAX) {
      throw new Error(
        `resolveByFiles: too many files (max ${FILES_MAX} per call; got ${files.length})`,
      );
    }
    const queryFiles = this.#expandSelfMemberFiles(files);
    // Self-member expansion can double the bind count, so a FILES_MAX bump
    // past ~16k fails here rather than as an opaque SQLite error.
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
   * A lone repo registers the platform directory itself as its member, so
   * `tags.file` carries a `<repo-basename>/` prefix the natural user input
   * lacks. The self-member is the repo row whose `path` is the platform root
   * (the parent of the canonical `spec-engine` row's path). In a multi-repo
   * platform every member lives under the root, so no row matches.
   *
   * Derived per call, never cached: `spec serve` reindexes through the same
   * handle and the repos table is rewritten each time.
   *
   * A platform directory literally named "spec-engine" collides with the
   * canonical row and is excluded by the name filter, so expansion never
   * fires for it.
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

  /** Both forms are kept; DISTINCT in the SELECT collapses any double match. */
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
    // `requirements.status` has no CHECK constraint on purpose: a bad status
    // lands verbatim so `spec check` can diagnose it.
    const db = this.#db;

    const insRepo = db.prepare(
      "INSERT OR REPLACE INTO repos (name, path, pinned_spec_version, dependency_depth) VALUES ($name, $path, $pin, $depth)",
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
    // The AUTOINCREMENT tables use plain INSERT, not OR REPLACE: every index
    // run starts from a clearAll'd table.
    const insTag = db.prepare(
      "INSERT INTO tags (req_id, repo, file, line, kind, level) " +
        "VALUES ($req, $repo, $file, $line, $kind, $level)",
    );
    const insDiag = db.prepare(
      "INSERT INTO parse_diagnostics (code, source_file, line, req_id, detail, severity) " +
        "VALUES ($code, $file, $line, $req, $detail, $sev)",
    );
    const insRelation = db.prepare(
      "INSERT INTO relations (from_id, to_id, source_file, line) " +
        "VALUES ($from, $to, $file, $line)",
    );
    // term_id is nullable with no FK, so an unresolved citation lands and is
    // diagnosed at check time.
    const insTermAlias = db.prepare(
      "INSERT INTO term_aliases (term_id, name) VALUES ($term, $name)",
    );
    const insTermCitation = db.prepare(
      "INSERT INTO term_citations (req_id, term_id, cited_as, pinned_version, source_file, line) " +
        "VALUES ($req, $term, $cited, $pinned, $file, $line)",
    );
    const insProvenance = db.prepare(
      "INSERT INTO provenance (req_id, issue_id, role, source_file, line) " +
        "VALUES ($req, $issue, $role, $file, $line)",
    );

    return {
      clearAll() {
        // DELETE FROM requirements fires requirements_ad per row, which keeps
        // requirements_fts in sync.
        for (const tbl of [
          "tags",
          "relations",
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
        // AUTOINCREMENT ids restart at 1 every rebuild, so rowids never drift
        // across runs even though build_id excludes them.
        db.exec("DELETE FROM sqlite_sequence;");
      },
      // Under `strict: true`, bind-object keys omit the `$` sigil: `$name` in
      // the SQL matches the JS key `name`, and a `$name` key throws "Missing
      // parameter". Verified against bun 1.3.14.
      upsertRepo(r) {
        insRepo.run({
          name: r.name,
          path: r.path,
          pin: r.pinned_spec_version,
          depth: r.dependency_depth,
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

// The helpers below serve the hidden CI smoke subcommands and tests; they live
// here because this is the one file that may touch bun:sqlite.

export interface SchemaInspection {
  tables: string[];
  views: string[];
  virtuals: string[];
  triggers: string[];
}

/** FTS5 virtual tables register as `type='table'`, so the `sql` tells them apart. */
export function inspectSchema(path: string): SchemaInspection {
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

export function poisonSchemaVersion(path: string, badVersion: number): void {
  const db = new Database(path);
  try {
    db.run("UPDATE _schema_version SET version = ?", [badVersion]);
  } finally {
    db.close();
  }
}

/** The row is deliberately bogus (`/dev/null`, pin 999) so no real scan could
 *  produce it, and a cold reset must be what removes it. */
export function poisonRepoRow(path: string, name: string): void {
  const db = new Database(path);
  try {
    db.run(
      "INSERT INTO repos (name, path, pinned_spec_version, dependency_depth) VALUES (?, ?, ?, ?)",
      [name, "/dev/null", 999, 0],
    );
  } finally {
    db.close();
  }
}

/** A read path independent of SqliteStorage.listRepos, so a test checks the
 *  rows rather than trusting the code under test. */
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

/**
 * Hashes a SQL projection, not the file bytes: free pages, journal mode, and
 * FTS5 layout vary across runs with identical rows. AUTOINCREMENT ids are
 * excluded so insertion order cannot reach the hash, every section carries a
 * full ORDER BY, and JSON.stringify follows SELECT column order. RS/US framing
 * keeps an empty section from colliding with a populated one. Opens its own
 * read-only handle so it never holds a lock against the caller's connection.
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
        sql: "SELECT name, path, pinned_spec_version, dependency_depth FROM repos ORDER BY name",
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
        sql:
          "SELECT req_id, repo, file, line, kind, level FROM tags " +
          "ORDER BY repo, file, line, req_id",
      },
      {
        label: "relations",
        sql:
          "SELECT from_id, to_id, source_file, line FROM relations " +
          "ORDER BY from_id, to_id, source_file, line",
      },
      {
        label: "term_aliases",
        sql: "SELECT term_id, name FROM term_aliases ORDER BY term_id, name",
      },
      {
        label: "term_citations",
        // Must match LIST_TERM_CITATIONS_SQL and the pipeline pre-sort.
        sql:
          "SELECT req_id, term_id, cited_as, pinned_version, source_file, line FROM term_citations " +
          "ORDER BY req_id, term_id, cited_as, source_file, line",
      },
      {
        label: "provenance",
        // Lexicographic, unlike the formatter's numeric-seq render order; the
        // hash only needs a stable order and never goes through the formatter.
        // The provenance_matrix view is not hashed: it projects these rows.
        sql:
          "SELECT req_id, issue_id, role, source_file, line FROM provenance " +
          "ORDER BY req_id, role, issue_id, source_file, line",
      },
      {
        label: "parse_diagnostics",
        sql:
          "SELECT code, source_file, line, req_id, detail, severity FROM parse_diagnostics " +
          "ORDER BY code, source_file, line, req_id, detail",
      },
    ];

    for (const { label, sql } of sections) {
      hash.update(`\x1e${label}\x1f`);
      const rows = db.query(sql).all();
      for (const row of rows) {
        hash.update("\x1e");
        hash.update(JSON.stringify(row));
      }
    }

    return hash.digest("hex");
  } finally {
    db.close();
  }
}
