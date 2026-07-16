// packages/engine/test/pipeline.test.ts
//
// Integration tests for `runIndex` (PARS-05 + INDX-01..04). Drives the
// real pipeline against fixtures/platform-fixture/, asserts the exact
// row counts + values produced, and proves end-to-end transaction
// rollback via a stub Storage.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Storage, WriteHandle } from "@spec-engine/shared";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-pipeline-test-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("runIndex against canonical platform-fixture", () => {
  test("IndexResult shape and exact row counts", async () => {
    const s = openStorage(dbPath);
    try {
      const r = await runIndex({ platformDir: FIXTURE, storage: s });
      expect(r.repos).toBe(4);
      expect(r.domains).toBe(2);
      expect(r.requirements).toBe(5);
      expect(r.tags).toBe(10);
      // PFIX-01 (Phase 12, Plan 12-04): the canonical fixture seeds a
      // malformed `**Issues:** ... bogus-no-colon ...` token, which surfaces
      // exactly one warning-severity UNKNOWN_ROLE parse diagnostic (PROV-05).
      expect(r.diagnostics).toBe(1);
      expect(r.build_id).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      s.close();
    }
  });

  test("repos table has exactly [admin, api, mobile, spec-engine] with correct pins", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
    } finally {
      s.close();
    }
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .query("SELECT name, pinned_spec_version FROM repos ORDER BY name")
      .all() as Array<{ name: string; pinned_spec_version: number }>;
    db.close();
    expect(rows).toEqual([
      { name: "admin", pinned_spec_version: 2 },
      { name: "api", pinned_spec_version: 2 },
      { name: "mobile", pinned_spec_version: 1 },
      { name: "spec-engine", pinned_spec_version: 2 },
    ]);
  });

  test("domains table has exactly [AUTH, BILLING] sourced from spec-engine", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
    } finally {
      s.close();
    }
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .query("SELECT key, spec_version, source_repo FROM domains ORDER BY key")
      .all() as Array<{ key: string; spec_version: number; source_repo: string }>;
    db.close();
    // spec_version is DERIVED from the supersede DAG (SCHM-006, 1 + edge count):
    // AUTH has zero supersede edges → 1; BILLING has one (BILLING-001→009) → 2.
    // The authored envelope specVersion (2 on both) is ignored.
    expect(rows).toEqual([
      { key: "AUTH", spec_version: 1, source_repo: "spec-engine" },
      { key: "BILLING", spec_version: 2, source_repo: "spec-engine" },
    ]);
  });

  test("requirements: all 5 ids with correct statuses + changed_at_version", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
    } finally {
      s.close();
    }
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .query("SELECT id, status, superseded_by, changed_at_version FROM requirements ORDER BY id")
      .all() as Array<{
      id: string;
      status: string;
      superseded_by: string | null;
      changed_at_version: number;
    }>;
    db.close();
    expect(rows).toEqual([
      { id: "AUTH-001", status: "Active", superseded_by: null, changed_at_version: 1 },
      {
        id: "BILLING-001",
        status: "Superseded",
        superseded_by: "BILLING-009",
        changed_at_version: 2,
      },
      { id: "BILLING-002", status: "Active", superseded_by: null, changed_at_version: 1 },
      { id: "BILLING-007", status: "Active", superseded_by: null, changed_at_version: 1 },
      { id: "BILLING-009", status: "Active", superseded_by: null, changed_at_version: 2 },
    ]);
  });

  test("requirements.source_file is platform-relative (e.g. spec-engine/BILLING/SPEC.json)", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
    } finally {
      s.close();
    }
    const db = new Database(dbPath, { readonly: true });
    const rows = db.query("SELECT id, source_file FROM requirements ORDER BY id").all() as Array<{
      id: string;
      source_file: string;
    }>;
    db.close();
    // Every source_file starts with "spec-engine/" and is NOT absolute.
    for (const r of rows) {
      expect(r.source_file.startsWith("spec-engine/")).toBe(true);
      expect(r.source_file.startsWith("/")).toBe(false);
    }
    // BILLING reqs live in BILLING/SPEC.json; AUTH-001 in AUTH/SPEC.json
    // (fixtures migrated to JSON in 18-03).
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.source_file]));
    expect(byId["BILLING-001"]).toBe("spec-engine/BILLING/SPEC.json");
    expect(byId["AUTH-001"]).toBe("spec-engine/AUTH/SPEC.json");
  });

  test("tags: exactly 10 rows with correct kind/level distribution", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
    } finally {
      s.close();
    }
    const db = new Database(dbPath, { readonly: true });
    const total = (db.query("SELECT COUNT(*) AS c FROM tags").get() as { c: number }).c;
    expect(total).toBe(10);

    // Per-repo tag count
    const perRepo = db
      .query("SELECT repo, COUNT(*) AS c FROM tags GROUP BY repo ORDER BY repo")
      .all() as Array<{ repo: string; c: number }>;
    db.close();
    expect(perRepo).toEqual([
      { repo: "admin", c: 3 },
      { repo: "api", c: 5 },
      { repo: "mobile", c: 2 },
    ]);
  });

  test("FIXT-04 negative-DRIFT row: mobile/src/tax.ts BILLING-007 tag", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
    } finally {
      s.close();
    }
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .query("SELECT file, kind, level FROM tags WHERE repo='mobile' AND req_id='BILLING-007'")
      .all() as Array<{ file: string; kind: string; level: string | null }>;
    db.close();
    expect(rows.length).toBe(1);
    expect(rows[0]?.file).toBe("mobile/src/tax.ts");
    expect(rows[0]?.kind).toBe("implements");
  });

  test("DANGLING_TAG: admin/src/reports.ts carries the planted BILLING-999 tag", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
    } finally {
      s.close();
    }
    const db = new Database(dbPath, { readonly: true });
    const rows = db.query("SELECT file FROM tags WHERE req_id='BILLING-999'").all() as Array<{
      file: string;
    }>;
    db.close();
    expect(rows.length).toBe(1);
    expect(rows[0]?.file).toBe("admin/src/reports.ts");
  });

  test("parse diagnostics: exactly the one seeded UNKNOWN_ROLE for the canonical fixture", async () => {
    // PFIX-01 (Phase 12, Plan 12-04): the fixture is structurally clean at the
    // PARSE layer except for the deliberately-seeded malformed `**Issues:**`
    // token, which surfaces exactly one warning-severity UNKNOWN_ROLE row
    // (PROV-05: surfaced AND dropped — never stored). The five structural /
    // cross-repo defects (DANGLING_TAG, DRIFT, ORPHAN_REQ,
    // SUPERSEDED_REFERENCED, UNVERIFIED_REQ) live at the CHECK layer, not here.
    const s = openStorage(dbPath);
    try {
      const r = await runIndex({ platformDir: FIXTURE, storage: s });
      expect(r.diagnostics).toBe(1);
    } finally {
      s.close();
    }
    const db = new Database(dbPath, { readonly: true });
    const rows = db.query("SELECT code FROM parse_diagnostics").all() as Array<{ code: string }>;
    db.close();
    expect(rows.length).toBe(1);
    expect(rows[0]?.code).toBe("UNKNOWN_ROLE");
  });

  test("widened discoverRepos return (skipped[]) does NOT change build_id for canonical fixture (Phase 7 / SC#4)", async () => {
    // ROADMAP SC#4 — Phase 7's signature widening MUST NOT alter the
    // build_id projection. We run runIndex twice A/B against the canonical
    // fixture and assert byte-identical hashes. The cross-commit lock
    // against the Phase 6 close hex is enforced separately by the
    // existing cold-rebuild.test.ts staying green (CI-02).
    const s = openStorage(dbPath);
    try {
      const a = await runIndex({ platformDir: FIXTURE, storage: s });
      const b = await runIndex({ platformDir: FIXTURE, storage: s });
      expect(a.build_id).toBe(b.build_id);
      expect(a.build_id).toMatch(/^[0-9a-f]{64}$/);
      // Zero-emission corollary against the canonical fixture: every
      // member here has a config (DISC-05), so skipped[] is empty and no
      // Phase 8 NO_SPEC_CONFIG emission fires. The single diagnostic is the
      // PFIX-01 seeded UNKNOWN_ROLE (parse layer), not a discovery emission.
      expect(a.diagnostics).toBe(1);
    } finally {
      s.close();
    }
  });
});

describe("runIndex idempotency (INDX-03 / INDX-04)", () => {
  test("two consecutive runIndex calls produce the same build_id and row counts", async () => {
    const s = openStorage(dbPath);
    try {
      const a = await runIndex({ platformDir: FIXTURE, storage: s });
      const b = await runIndex({ platformDir: FIXTURE, storage: s });
      expect(b.build_id).toBe(a.build_id);
      expect(b.repos).toBe(a.repos);
      expect(b.requirements).toBe(a.requirements);
      expect(b.tags).toBe(a.tags);
    } finally {
      s.close();
    }
  });

  test("re-indexing leaves the same row counts (clearAll + re-upsert is idempotent)", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
      await runIndex({ platformDir: FIXTURE, storage: s });
    } finally {
      s.close();
    }
    const db = new Database(dbPath, { readonly: true });
    const counts = {
      repos: (db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c,
      requirements: (db.query("SELECT COUNT(*) AS c FROM requirements").get() as { c: number }).c,
      tags: (db.query("SELECT COUNT(*) AS c FROM tags").get() as { c: number }).c,
    };
    db.close();
    expect(counts).toEqual({ repos: 4, requirements: 5, tags: 10 });
  });
});

describe("runIndex tx rollback (INDX-04 end-to-end)", () => {
  test("throwing inside the transaction rolls back clearAll — prior rows survive", async () => {
    // First: run a normal index so the DB has rows in it.
    const real = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: real });
    } finally {
      real.close();
    }

    // Sanity: DB now has rows
    {
      const db = new Database(dbPath, { readonly: true });
      const c = (db.query("SELECT COUNT(*) AS c FROM requirements").get() as { c: number }).c;
      db.close();
      expect(c).toBe(5);
    }

    // Now: open the same DB through a wrapped Storage that throws after
    // the first upsertTag call. We invoke runIndex; it should throw, and
    // because the entire body runs inside ONE withWriteTx, every write
    // (including the upstream clearAll) must be rolled back.
    const wrapped = openStorage(dbPath);
    const poisoned: Storage = new Proxy(wrapped, {
      get(target, prop, receiver) {
        if (prop === "withWriteTx") {
          return <T>(fn: (w: WriteHandle) => T): T => {
            return target.withWriteTx((w) => {
              let tagCount = 0;
              const wp: WriteHandle = {
                clearAll: () => w.clearAll(),
                upsertRepo: (r) => w.upsertRepo(r),
                upsertDomain: (d) => w.upsertDomain(d),
                upsertRequirement: (r) => w.upsertRequirement(r),
                upsertRelation: (r) => w.upsertRelation(r),
                upsertTermAlias: (a) => w.upsertTermAlias(a),
                upsertTermCitation: (c) => w.upsertTermCitation(c),
                upsertProvenance: (p) => w.upsertProvenance(p),
                upsertTag: (t) => {
                  tagCount++;
                  if (tagCount > 2) {
                    throw new Error("poisoned upsertTag (test)");
                  }
                  w.upsertTag(t);
                },
                recordParseDiagnostic: (d) => w.recordParseDiagnostic(d),
              };
              return fn(wp);
            });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    let threw = false;
    try {
      await runIndex({ platformDir: FIXTURE, storage: poisoned });
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("poisoned upsertTag");
    }
    expect(threw).toBe(true);
    wrapped.close();

    // After the poisoned run, the DB must contain ONLY the pre-poison rows.
    // Because clearAll() ran inside the same withWriteTx as the poisoned
    // upsertTag, SQLite's automatic rollback restores the pre-transaction
    // state — the truncation is undone and the original 5/4/10 rows remain.
    const db = new Database(dbPath, { readonly: true });
    const reqs = (db.query("SELECT COUNT(*) AS c FROM requirements").get() as { c: number }).c;
    const repos = (db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c;
    const tags = (db.query("SELECT COUNT(*) AS c FROM tags").get() as { c: number }).c;
    db.close();
    // Pre-poison rows survived (clearAll was rolled back).
    expect(reqs).toBe(5);
    expect(repos).toBe(4);
    expect(tags).toBe(10);
  });
});

describe("NO_SPEC_CONFIG emission (Phase 8 / DISC-03, DISC-04)", () => {
  test("emits one warning-severity diagnostic per sibling-without-config", async () => {
    const platDir = join(tmp, "platform");
    await mkdir(join(platDir, "spec-engine"), { recursive: true });
    await mkdir(join(platDir, "strangers"), { recursive: true });
    // RUNG1-02: `strangers/` must carry a repo-root marker to be a skipped
    // sibling (a real unwired member repo) that drives NO_SPEC_CONFIG.
    await writeFile(join(platDir, "strangers", "package.json"), JSON.stringify({ name: "x" }));

    const tmpDbPath = join(tmp, "platform-index.sqlite");
    const s = openStorage(tmpDbPath);
    try {
      const r = await runIndex({ platformDir: platDir, storage: s });
      expect(r.diagnostics).toBe(1); // IndexResult surface
    } finally {
      s.close();
    }

    // Storage-level truth — independent measurement.
    const db = new Database(tmpDbPath, { readonly: true });
    const rows = db
      .query(
        "SELECT code, source_file, line, req_id, detail, severity " +
          "FROM parse_diagnostics WHERE code = 'NO_SPEC_CONFIG'",
      )
      .all() as Array<{
      code: string;
      source_file: string;
      line: number;
      req_id: string | null;
      detail: string;
      severity: string;
    }>;
    db.close();
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (!row) throw new Error("expected exactly one diagnostics row");
    expect(row.code).toBe("NO_SPEC_CONFIG");
    expect(row.severity).toBe("warning");
    expect(row.source_file).toBe("strangers"); // DISC-04: platform-relative
    expect(row.source_file.startsWith("/")).toBe(false); // DISC-04: NEVER absolute
    expect(row.line).toBe(0);
    expect(row.req_id).toBeNull();
    expect(row.detail).toContain("strangers"); // dir name verbatim
    expect(row.detail).toContain("spec init strangers"); // clipboard-ready remediation
  });

  test("canonical fixture emits zero NO_SPEC_CONFIG warnings", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
    } finally {
      s.close();
    }
    const db = new Database(dbPath, { readonly: true });
    const count = (
      db
        .query("SELECT COUNT(*) AS c FROM parse_diagnostics WHERE code = 'NO_SPEC_CONFIG'")
        .get() as { c: number }
    ).c;
    db.close();
    expect(count).toBe(0);
  });

  test("two siblings without configs produce diagnostics in lex-by-name order across cold rebuilds", async () => {
    const platDir = join(tmp, "platform");
    await mkdir(join(platDir, "spec-engine"), { recursive: true });
    await mkdir(join(platDir, "zulu"), { recursive: true });
    await mkdir(join(platDir, "alpha"), { recursive: true });
    // RUNG1-02: both config-less siblings must carry a repo-root marker to be
    // classified as skipped (real unwired member repos → NO_SPEC_CONFIG).
    await writeFile(join(platDir, "zulu", "package.json"), JSON.stringify({ name: "zulu" }));
    await writeFile(join(platDir, "alpha", "package.json"), JSON.stringify({ name: "alpha" }));

    const tmpDbPath = join(tmp, "platform-index.sqlite");

    // Pass 1 — warm
    const s1 = openStorage(tmpDbPath);
    const a = await runIndex({ platformDir: platDir, storage: s1 });
    s1.close();

    // Cold — rm DB + WAL + SHM. Guard each rmSync with existsSync rather
    // than swallowing every error — WAL/SHM may legitimately not exist
    // (small DB closed before WAL spilled), but EBUSY / EACCES /
    // "directory exists" would silently false-green the cold-rebuild
    // assertion under an empty `catch {}`. existsSync narrows the path
    // to "file exists → remove it"; any rmSync error is then a real
    // defect (WR-03 review-fix).
    for (const sfx of ["", "-wal", "-shm"]) {
      const p = tmpDbPath + sfx;
      if (existsSync(p)) rmSync(p);
    }

    // Pass 2 — cold
    const s2 = openStorage(tmpDbPath);
    const c = await runIndex({ platformDir: platDir, storage: s2 });
    s2.close();

    expect(a.build_id).toBe(c.build_id); // BUILD-01 byte-stability with skipped sibling
    expect(a.build_id).toMatch(/^[0-9a-f]{64}$/);

    const db = new Database(tmpDbPath, { readonly: true });
    const rows = db
      .query(
        "SELECT source_file FROM parse_diagnostics " + "WHERE code = 'NO_SPEC_CONFIG' ORDER BY id",
      )
      .all() as Array<{ source_file: string }>;
    db.close();
    expect(rows.map((r) => r.source_file)).toEqual(["alpha", "zulu"]); // lex order
  });
});

// ----------------------------------------------------------------------------
// RED-14 dead-end audit: the "write committed but build_id hashing failed"
// rethrow in runIndex existed without a covering test.
// ----------------------------------------------------------------------------

describe("runIndex build_id hashing failure (RED-14)", () => {
  test("hash-phase failure rethrows with the diagnostic message; the committed index survives on disk", async () => {
    const s = openStorage(dbPath);
    try {
      // Decorate the real storage so every write goes through the actual
      // engine, but the post-commit hash phase (computeBuildId re-opens the
      // DB read-only via storage.path) sees a path that cannot be opened.
      // NOTE: methods are bound to the REAL storage (not the proxy) so
      // bun:sqlite's class-private fields stay reachable through the
      // delegated calls; only the `path` read is intercepted.
      const sabotaged = new Proxy(s, {
        get(target, prop) {
          if (prop === "path") return join(tmp, "missing-subdir", "ghost.sqlite");
          const v = Reflect.get(target, prop);
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) as typeof s;

      await expect(runIndex({ platformDir: FIXTURE, storage: sabotaged })).rejects.toThrow(
        /build_id hashing failed/,
      );
    } finally {
      s.close();
    }

    // The message's claim — "the derived index is intact on disk" — must be
    // true: the write transaction committed before the hash phase ran.
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT COUNT(*) AS n FROM repos").get() as { n: number };
    db.close();
    expect(row.n).toBe(4);
  });
});
