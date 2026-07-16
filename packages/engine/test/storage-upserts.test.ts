// packages/engine/test/storage-upserts.test.ts
//
// Phase 2 / Plan 02-03 — proves every WriteHandle upsert, FTS5 sync,
// transaction rollback (INDX-04 / Assumption A2), and sqlite_sequence reset.
// File-DB tests per CLAUDE.md Q8 (mkdtempSync, NOT :memory:).

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParseDiagnostic, Repo, Requirement, Tag } from "@spec-engine/shared";
import { computeBuildId, openStorage } from "../src/storage/sqlite";

// ---------------------------------------------------------------------------
// Scaffold: fresh tmp DB per test (file-mode; not :memory:). CLAUDE.md Q8.
// ---------------------------------------------------------------------------

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-storage-upserts-"));
  dbPath = join(tmp, "x.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Sample row fixtures (deterministic, minimal).
// ---------------------------------------------------------------------------

const SAMPLE_REPO: Repo = { name: "api", path: "/x/api", pinned_spec_version: 2 };

const SAMPLE_REQ: Requirement = {
  id: "BILLING-009",
  key: "BILLING",
  seq: 9,
  status: "Active",
  superseded_by: null,
  text: "Renews charge at midnight UTC.",
  why: "Revenue continuity.",
  source_file: "spec-engine/BILLING/SPEC.md",
  line: 10,
  spec_version: 2,
  changed_at_version: 2,
  superseded_at_version: null,
};

const SAMPLE_TAG: Omit<Tag, "id"> = {
  req_id: "BILLING-009",
  repo: "api",
  file: "api/src/renew.ts",
  line: 1,
  kind: "implements",
  level: null,
};

const SAMPLE_DIAG: Omit<ParseDiagnostic, "id"> = {
  code: "DUP_ID",
  source_file: "spec-engine/BILLING/SPEC.md",
  line: 5,
  req_id: "BILLING-001",
  detail: "duplicate id",
  severity: "error",
};

// ---------------------------------------------------------------------------
// upsertRepo
// ---------------------------------------------------------------------------

describe("upsertRepo", () => {
  test("inserts one repo; SELECT shows correct columns", () => {
    const s = openStorage(dbPath);
    s.withWriteTx((w) => {
      w.upsertRepo(SAMPLE_REPO);
    });
    s.close();

    const db = new Database(dbPath);
    const row = db.query("SELECT name, path, pinned_spec_version FROM repos").get() as {
      name: string;
      path: string;
      pinned_spec_version: number;
    } | null;
    db.close();

    expect(row).not.toBeNull();
    expect(row?.name).toBe("api");
    expect(row?.path).toBe("/x/api");
    expect(row?.pinned_spec_version).toBe(2);
  });

  test("idempotent: calling with same name twice leaves exactly 1 row (INSERT OR REPLACE)", () => {
    const s = openStorage(dbPath);
    s.withWriteTx((w) => {
      w.upsertRepo({ name: "api", path: "/old/path", pinned_spec_version: 1 });
      w.upsertRepo({ name: "api", path: "/new/path", pinned_spec_version: 2 });
    });
    s.close();

    const db = new Database(dbPath);
    const count = (db.query("SELECT count(*) AS c FROM repos").get() as { c: number }).c;
    const row = db.query("SELECT path, pinned_spec_version FROM repos").get() as {
      path: string;
      pinned_spec_version: number;
    };
    db.close();

    expect(count).toBe(1);
    expect(row.path).toBe("/new/path");
    expect(row.pinned_spec_version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// upsertDomain
// ---------------------------------------------------------------------------

describe("upsertDomain", () => {
  test("inserts with null owner/schema landing as SQL NULL (not the string 'null')", () => {
    const s = openStorage(dbPath);
    s.withWriteTx((w) => {
      w.upsertDomain({
        key: "BILLING",
        owner: null,
        schema: null,
        spec_version: 2,
        source_repo: "spec-engine",
      });
    });
    s.close();

    const db = new Database(dbPath);
    const row = db
      .query(
        "SELECT key, owner, schema, spec_version, source_repo, " +
          "owner IS NULL AS owner_is_null, schema IS NULL AS schema_is_null FROM domains",
      )
      .get() as {
      key: string;
      owner: string | null;
      schema: string | null;
      spec_version: number;
      source_repo: string;
      owner_is_null: number;
      schema_is_null: number;
    } | null;
    db.close();

    expect(row).not.toBeNull();
    expect(row?.key).toBe("BILLING");
    expect(row?.owner).toBeNull();
    expect(row?.schema).toBeNull();
    expect(row?.owner_is_null).toBe(1);
    expect(row?.schema_is_null).toBe(1);
    expect(row?.spec_version).toBe(2);
    expect(row?.source_repo).toBe("spec-engine");
  });
});

// ---------------------------------------------------------------------------
// upsertRequirement
// ---------------------------------------------------------------------------

describe("upsertRequirement", () => {
  test("inserts one requirement; SELECT returns all 12 columns matching input", () => {
    const s = openStorage(dbPath);
    s.withWriteTx((w) => {
      w.upsertRequirement(SAMPLE_REQ);
    });
    s.close();

    const db = new Database(dbPath);
    const row = db
      .query(
        "SELECT id, key, seq, status, superseded_by, text, why, source_file, line, " +
          "spec_version, changed_at_version, superseded_at_version FROM requirements",
      )
      .get() as Requirement | null;
    db.close();

    expect(row).not.toBeNull();
    expect(row).toEqual(SAMPLE_REQ);
  });

  test("BAD_STATUS string lands verbatim (Pitfall 3 / Invariant #4 — no CHECK constraint)", () => {
    const s = openStorage(dbPath);
    s.withWriteTx((w) => {
      // Cast at the seam (Pitfall 3 recommended approach B): TS narrow elsewhere,
      // DB stores the raw bad value for diagnostic recovery.
      w.upsertRequirement({
        ...SAMPLE_REQ,
        id: "BILLING-010",
        seq: 10,
        status: "Drft" as Requirement["status"],
      });
    });
    s.close();

    const db = new Database(dbPath);
    const row = db.query("SELECT status FROM requirements WHERE id='BILLING-010'").get() as {
      status: string;
    } | null;
    db.close();

    expect(row?.status).toBe("Drft");
  });
});

// ---------------------------------------------------------------------------
// upsertTag
// ---------------------------------------------------------------------------

describe("upsertTag", () => {
  test("inserts one tag; AUTOINCREMENT id starts at 1", () => {
    const s = openStorage(dbPath);
    s.withWriteTx((w) => {
      w.upsertTag(SAMPLE_TAG);
    });
    s.close();

    const db = new Database(dbPath);
    const row = db
      .query("SELECT id, req_id, repo, file, line, kind, level FROM tags")
      .get() as Tag | null;
    db.close();

    expect(row).not.toBeNull();
    expect(row?.id).toBe(1);
    expect(row?.req_id).toBe("BILLING-009");
    expect(row?.repo).toBe("api");
    expect(row?.file).toBe("api/src/renew.ts");
    expect(row?.line).toBe(1);
    expect(row?.kind).toBe("implements");
    expect(row?.level).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recordParseDiagnostic
// ---------------------------------------------------------------------------

describe("recordParseDiagnostic", () => {
  test("inserts one diagnostic; SELECT shows the row", () => {
    const s = openStorage(dbPath);
    s.withWriteTx((w) => {
      w.recordParseDiagnostic(SAMPLE_DIAG);
    });
    s.close();

    const db = new Database(dbPath);
    const row = db
      .query("SELECT id, code, source_file, line, req_id, detail, severity FROM parse_diagnostics")
      .get() as ParseDiagnostic | null;
    db.close();

    expect(row).not.toBeNull();
    expect(row?.id).toBe(1);
    expect(row?.code).toBe("DUP_ID");
    expect(row?.source_file).toBe("spec-engine/BILLING/SPEC.md");
    expect(row?.line).toBe(5);
    expect(row?.req_id).toBe("BILLING-001");
    expect(row?.detail).toBe("duplicate id");
    expect(row?.severity).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// clearAll
// ---------------------------------------------------------------------------

describe("clearAll", () => {
  test("empties all five tables; subsequent upsertTag returns id=1 (sqlite_sequence reset)", () => {
    const s = openStorage(dbPath);

    // Populate, then clear, then re-populate one tag.
    s.withWriteTx((w) => {
      w.upsertRepo(SAMPLE_REPO);
      w.upsertDomain({
        key: "BILLING",
        owner: null,
        schema: null,
        spec_version: 2,
        source_repo: "spec-engine",
      });
      w.upsertRequirement(SAMPLE_REQ);
      w.upsertTag(SAMPLE_TAG);
      w.upsertTag({ ...SAMPLE_TAG, file: "api/src/renew2.ts" });
      // RED-16: relations must participate in the clearAll contract too.
      w.upsertRelation({
        from_id: "BILLING-009",
        to_id: "BILLING-002",
        source_file: "spec-engine/BILLING/SPEC.md",
        line: 12,
      });
      w.recordParseDiagnostic(SAMPLE_DIAG);
    });

    // Verify populated.
    {
      const db = new Database(dbPath);
      expect((db.query("SELECT count(*) AS c FROM tags").get() as { c: number }).c).toBe(2);
      db.close();
    }

    s.withWriteTx((w) => {
      w.clearAll();
    });

    // All six tables empty after clearAll (relations joined in RED-16).
    {
      const db = new Database(dbPath);
      for (const tbl of [
        "tags",
        "relations",
        "requirements",
        "domains",
        "repos",
        "parse_diagnostics",
      ]) {
        const c = (db.query(`SELECT count(*) AS c FROM ${tbl}`).get() as { c: number }).c;
        expect(c).toBe(0);
      }
      db.close();
    }

    // Re-insert one tag — id MUST be 1 again (sqlite_sequence was reset).
    s.withWriteTx((w) => {
      w.upsertTag(SAMPLE_TAG);
    });
    s.close();

    const db = new Database(dbPath);
    const row = db.query("SELECT id FROM tags").get() as { id: number };
    db.close();

    expect(row.id).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// FTS5 sync (Pitfall 2 — _ai/_ad/_au triggers fire in the same transaction)
// ---------------------------------------------------------------------------

describe("FTS5 sync (Pitfall 2)", () => {
  test("count(requirements_fts) tracks count(requirements) across insert/clearAll/insert", () => {
    const s = openStorage(dbPath);

    // Step 1: insert one requirement → fts count == 1.
    s.withWriteTx((w) => {
      w.upsertRequirement(SAMPLE_REQ);
    });

    {
      const db = new Database(dbPath);
      const reqCount = (db.query("SELECT count(*) AS c FROM requirements").get() as { c: number })
        .c;
      const ftsCount = (
        db.query("SELECT count(*) AS c FROM requirements_fts").get() as { c: number }
      ).c;
      db.close();
      expect(reqCount).toBe(1);
      expect(ftsCount).toBe(1);
    }

    // Step 2: clearAll → fts count == 0 (requirements_ad trigger fires per row).
    s.withWriteTx((w) => {
      w.clearAll();
    });

    {
      const db = new Database(dbPath);
      const reqCount = (db.query("SELECT count(*) AS c FROM requirements").get() as { c: number })
        .c;
      const ftsCount = (
        db.query("SELECT count(*) AS c FROM requirements_fts").get() as { c: number }
      ).c;
      db.close();
      expect(reqCount).toBe(0);
      expect(ftsCount).toBe(0);
    }

    // Step 3: re-insert → fts count == 1 again.
    s.withWriteTx((w) => {
      w.upsertRequirement(SAMPLE_REQ);
    });
    s.close();

    const db = new Database(dbPath);
    const reqCount = (db.query("SELECT count(*) AS c FROM requirements").get() as { c: number }).c;
    const ftsCount = (db.query("SELECT count(*) AS c FROM requirements_fts").get() as { c: number })
      .c;
    db.close();

    expect(reqCount).toBe(1);
    expect(ftsCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// withWriteTx rollback (INDX-04 / Assumption A2: synchronous throw → rollback)
// ---------------------------------------------------------------------------

describe("withWriteTx rollback (INDX-04 / Assumption A2)", () => {
  test("synchronous throw inside the tx rolls back all writes; DB stays empty", () => {
    const s = openStorage(dbPath);

    expect(() =>
      s.withWriteTx((w) => {
        w.upsertRepo(SAMPLE_REPO);
        w.upsertRequirement(SAMPLE_REQ);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    s.close();

    const db = new Database(dbPath);
    const repoCount = (db.query("SELECT count(*) AS c FROM repos").get() as { c: number }).c;
    const reqCount = (db.query("SELECT count(*) AS c FROM requirements").get() as { c: number }).c;
    const ftsCount = (db.query("SELECT count(*) AS c FROM requirements_fts").get() as { c: number })
      .c;
    db.close();

    expect(repoCount).toBe(0);
    expect(reqCount).toBe(0);
    expect(ftsCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeBuildId — Phase 2 deterministic content hash (INDX-03 / CI-02)
// ---------------------------------------------------------------------------

/**
 * Helper: populate a DB with a fixed, deterministic dataset suitable for
 * cross-DB hash comparison. Returns the open Storage so callers can decide
 * when to close it.
 */
function populateDeterministic(path: string) {
  const s = openStorage(path);
  s.withWriteTx((w) => {
    w.upsertRepo({ name: "api", path: "/x/api", pinned_spec_version: 2 });
    w.upsertRepo({ name: "mobile", path: "/x/mobile", pinned_spec_version: 1 });
    w.upsertDomain({
      key: "BILLING",
      owner: null,
      schema: null,
      spec_version: 2,
      source_repo: "spec-engine",
    });
    w.upsertRequirement(SAMPLE_REQ);
    w.upsertRequirement({
      ...SAMPLE_REQ,
      id: "BILLING-007",
      seq: 7,
      text: "Tax line item.",
      spec_version: 1,
      changed_at_version: 1,
    });
    w.upsertTag({ ...SAMPLE_TAG, file: "api/src/a.ts" });
    w.upsertTag({ ...SAMPLE_TAG, file: "api/src/b.ts" });
    w.upsertTag({ ...SAMPLE_TAG, file: "api/src/c.ts" });
    w.recordParseDiagnostic(SAMPLE_DIAG);
  });
  return s;
}

describe("computeBuildId", () => {
  test("empty DB → 64-char lowercase hex SHA-256 digest", () => {
    const s = openStorage(dbPath);
    const id = computeBuildId(s);
    s.close();

    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("two DBs with identical content → identical hash (paths differ)", () => {
    const pathA = join(tmp, "a.sqlite");
    const pathB = join(tmp, "b.sqlite");

    const sA = populateDeterministic(pathA);
    const sB = populateDeterministic(pathB);

    const idA = computeBuildId(sA);
    const idB = computeBuildId(sB);

    sA.close();
    sB.close();

    expect(idA).toBe(idB);
    expect(idA).toMatch(/^[0-9a-f]{64}$/);
  });

  test("mutating one requirement.text changes the hash", () => {
    const pathA = join(tmp, "a.sqlite");
    const pathB = join(tmp, "b.sqlite");

    const sA = populateDeterministic(pathA);
    const sB = openStorage(pathB);
    sB.withWriteTx((w) => {
      w.upsertRepo({ name: "api", path: "/x/api", pinned_spec_version: 2 });
      w.upsertRepo({ name: "mobile", path: "/x/mobile", pinned_spec_version: 1 });
      w.upsertDomain({
        key: "BILLING",
        owner: null,
        schema: null,
        spec_version: 2,
        source_repo: "spec-engine",
      });
      // ONLY difference from populateDeterministic: BILLING-009.text mutated.
      w.upsertRequirement({ ...SAMPLE_REQ, text: "MUTATED" });
      w.upsertRequirement({
        ...SAMPLE_REQ,
        id: "BILLING-007",
        seq: 7,
        text: "Tax line item.",
        spec_version: 1,
        changed_at_version: 1,
      });
      w.upsertTag({ ...SAMPLE_TAG, file: "api/src/a.ts" });
      w.upsertTag({ ...SAMPLE_TAG, file: "api/src/b.ts" });
      w.upsertTag({ ...SAMPLE_TAG, file: "api/src/c.ts" });
      w.recordParseDiagnostic(SAMPLE_DIAG);
    });

    const idA = computeBuildId(sA);
    const idB = computeBuildId(sB);

    sA.close();
    sB.close();

    expect(idA).not.toBe(idB);
  });

  test("tags.id reset does NOT change the hash (AUTOINCREMENT excluded from projection)", () => {
    const s = populateDeterministic(dbPath);
    const idBefore = computeBuildId(s);

    // Clear and re-populate with identical content.
    s.withWriteTx((w) => {
      w.clearAll();
    });
    // After clearAll, sqlite_sequence is reset; re-insert the same rows.
    s.withWriteTx((w) => {
      w.upsertRepo({ name: "api", path: "/x/api", pinned_spec_version: 2 });
      w.upsertRepo({ name: "mobile", path: "/x/mobile", pinned_spec_version: 1 });
      w.upsertDomain({
        key: "BILLING",
        owner: null,
        schema: null,
        spec_version: 2,
        source_repo: "spec-engine",
      });
      w.upsertRequirement(SAMPLE_REQ);
      w.upsertRequirement({
        ...SAMPLE_REQ,
        id: "BILLING-007",
        seq: 7,
        text: "Tax line item.",
        spec_version: 1,
        changed_at_version: 1,
      });
      w.upsertTag({ ...SAMPLE_TAG, file: "api/src/a.ts" });
      w.upsertTag({ ...SAMPLE_TAG, file: "api/src/b.ts" });
      w.upsertTag({ ...SAMPLE_TAG, file: "api/src/c.ts" });
      w.recordParseDiagnostic(SAMPLE_DIAG);
    });

    const idAfter = computeBuildId(s);
    s.close();

    expect(idAfter).toBe(idBefore);
  });

  test("tag insertion order does NOT change the hash (ORDER BY in projection)", () => {
    const pathA = join(tmp, "a.sqlite");
    const pathB = join(tmp, "b.sqlite");

    const sA = openStorage(pathA);
    const sB = openStorage(pathB);

    // Common base rows (must NOT differ between A and B).
    const seed = (w: Parameters<Parameters<typeof sA.withWriteTx>[0]>[0]) => {
      w.upsertRepo({ name: "api", path: "/x/api", pinned_spec_version: 2 });
      w.upsertDomain({
        key: "BILLING",
        owner: null,
        schema: null,
        spec_version: 2,
        source_repo: "spec-engine",
      });
      w.upsertRequirement(SAMPLE_REQ);
    };

    const tagA = { ...SAMPLE_TAG, file: "api/src/a.ts" };
    const tagB = { ...SAMPLE_TAG, file: "api/src/b.ts" };
    const tagC = { ...SAMPLE_TAG, file: "api/src/c.ts" };

    // Insert order A → B → C
    sA.withWriteTx((w) => {
      seed(w);
      w.upsertTag(tagA);
      w.upsertTag(tagB);
      w.upsertTag(tagC);
    });

    // Insert order C → B → A (same logical content, different AUTOINCREMENT order)
    sB.withWriteTx((w) => {
      seed(w);
      w.upsertTag(tagC);
      w.upsertTag(tagB);
      w.upsertTag(tagA);
    });

    const idA = computeBuildId(sA);
    const idB = computeBuildId(sB);

    sA.close();
    sB.close();

    expect(idA).toBe(idB);
  });
});
