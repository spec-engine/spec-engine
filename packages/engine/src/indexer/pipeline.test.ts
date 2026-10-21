import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Storage, WriteHandle } from "@spec-engine/shared";
import { openStorage } from "../storage/sqlite";
import { TestPlatform } from "../testing/platform";
import { runIndex } from "./pipeline";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

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
      // The fixture's one planted malformed issue token: UNKNOWN_ROLE.
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
    // Derived as 1 + supersede edge count; the authored specVersion (2 on
    // both) is ignored.
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
    for (const r of rows) {
      expect(r.source_file.startsWith("spec-engine/")).toBe(true);
      expect(r.source_file.startsWith("/")).toBe(false);
    }
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

  test("negative-DRIFT row: mobile/src/tax.ts BILLING-007 tag", async () => {
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
    // The fixture's other planted defects surface in `spec check`, not here.
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

  test("a fully pinned platform hashes identically twice and adds no discovery diagnostic", async () => {
    const s = openStorage(dbPath);
    try {
      const a = await runIndex({ platformDir: FIXTURE, storage: s });
      const b = await runIndex({ platformDir: FIXTURE, storage: s });
      expect(a.build_id).toBe(b.build_id);
      expect(a.build_id).toMatch(/^[0-9a-f]{64}$/);
      expect(a.diagnostics).toBe(1);
    } finally {
      s.close();
    }
  });
});

describe("runIndex idempotency", () => {
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

describe("runIndex tx rollback", () => {
  test("throwing inside the transaction rolls back clearAll — prior rows survive", async () => {
    const real = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: real });
    } finally {
      real.close();
    }

    {
      const db = new Database(dbPath, { readonly: true });
      const c = (db.query("SELECT COUNT(*) AS c FROM requirements").get() as { c: number }).c;
      db.close();
      expect(c).toBe(5);
    }

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

    const db = new Database(dbPath, { readonly: true });
    const reqs = (db.query("SELECT COUNT(*) AS c FROM requirements").get() as { c: number }).c;
    const repos = (db.query("SELECT COUNT(*) AS c FROM repos").get() as { c: number }).c;
    const tags = (db.query("SELECT COUNT(*) AS c FROM tags").get() as { c: number }).c;
    db.close();
    expect(reqs).toBe(5);
    expect(repos).toBe(4);
    expect(tags).toBe(10);
  });
});

describe("NO_SPEC_CONFIG emission", () => {
  test("emits one warning-severity diagnostic per declared member without a pin", async () => {
    const platDir = join(tmp, "platform");
    TestPlatform.at(platDir).unpinned("strangers");

    const tmpDbPath = join(tmp, "platform-index.sqlite");
    const s = openStorage(tmpDbPath);
    try {
      const r = await runIndex({ platformDir: platDir, storage: s });
      expect(r.diagnostics).toBe(1);
    } finally {
      s.close();
    }

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
    expect(row.source_file).toBe("strangers");
    expect(row.source_file.startsWith("/")).toBe(false);
    expect(row.line).toBe(0);
    expect(row.req_id).toBeNull();
    expect(row.detail).toContain("strangers");
    expect(row.detail).toContain("spec init strangers");
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

  test("two members without pins produce diagnostics in lex-by-name order across cold rebuilds", async () => {
    const platDir = join(tmp, "platform");
    const fx = TestPlatform.at(platDir);
    fx.unpinned("zulu");
    fx.unpinned("alpha");

    const tmpDbPath = join(tmp, "platform-index.sqlite");

    const s1 = openStorage(tmpDbPath);
    const a = await runIndex({ platformDir: platDir, storage: s1 });
    s1.close();

    // existsSync, not an empty catch: WAL/SHM may legitimately be absent, but
    // a swallowed EBUSY/EACCES would false-green the cold rebuild.
    for (const sfx of ["", "-wal", "-shm"]) {
      const p = tmpDbPath + sfx;
      if (existsSync(p)) rmSync(p);
    }

    const s2 = openStorage(tmpDbPath);
    const c = await runIndex({ platformDir: platDir, storage: s2 });
    s2.close();

    expect(a.build_id).toBe(c.build_id);
    expect(a.build_id).toMatch(/^[0-9a-f]{64}$/);

    const db = new Database(tmpDbPath, { readonly: true });
    const rows = db
      .query(
        "SELECT source_file FROM parse_diagnostics " + "WHERE code = 'NO_SPEC_CONFIG' ORDER BY id",
      )
      .all() as Array<{ source_file: string }>;
    db.close();
    expect(rows.map((r) => r.source_file)).toEqual(["alpha", "zulu"]);
  });
});

describe("runIndex build_id hashing failure", () => {
  test("hash-phase failure rethrows with the diagnostic message; the committed index survives on disk", async () => {
    const s = openStorage(dbPath);
    try {
      // computeBuildId reopens the DB through storage.path, so only `path` is
      // intercepted. Methods bind to the real storage, not the proxy, so the
      // class-private fields stay reachable.
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

    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT COUNT(*) AS n FROM repos").get() as { n: number };
    db.close();
    expect(row.n).toBe(4);
  });
});
