// packages/engine/test/provenance-issueid-opacity.test.ts
//
// @spec PROV-001
// PROV-02 behavioral lock: issue_id is stored as an OPAQUE string and is NEVER
// used as a PK/FK/JOIN/coverage/routing key. The CI `issue_id-opacity`
// grep-fence (ci.yml) statically forbids issue_id appearing in any identity
// construct, but that fence is YAML-only — it cannot run under `bun test` and
// it proves the SOURCE never *names* issue_id as a key, not that the live VIEW
// *behaves* opaquely. This test closes that gap with a runnable behavioral
// assertion against the real `provenance_matrix` VIEW.
//
// The adversarial probe: seed a provenance row whose opaque issue_id COLLIDES,
// byte-for-byte, with a REAL requirement id (a KEY-NNN-shaped id, BILLING-001),
// attached to a DIFFERENT requirement (AUTH-001) whose status differs from the
// collided requirement's status. If issue_id ever leaked into the VIEW's join /
// routing path, the row's `req_status` (or a reverse lookup) would resolve
// through the COLLIDED requirement (BILLING-001 → "Superseded") instead of the
// owning requirement (AUTH-001 → "Active"). A passing test proves the join
// keys strictly on req_id and the issue_id rides as a pure projected value.
//
// Seeds a tmp file-DB directly with the canonical DDL (mirroring
// provenance-test-levels-dedup.test.ts's `new Database(path)` seeding pattern)
// so it exercises the REAL VIEW, not a hand-built row.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DDL, SCHEMA_VERSION } from "@spec-engine/shared";
import { openStorage } from "../src/storage/sqlite";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-prov-opacity-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Seed a derived index with two requirements whose statuses DIFFER:
 *   - AUTH-001     status Active     — owns a provenance link
 *   - BILLING-001  status Superseded — the requirement whose id is REUSED as the
 *                                      opaque issue_id on AUTH-001's link
 * The provenance row is `AUTH-001 | created | BILLING-001`: a KEY-NNN-shaped
 * opaque issue id that collides with the real requirement BILLING-001.
 */
function seedColliding(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  db.exec(DDL);
  db.run("INSERT INTO _schema_version (version) VALUES (?)", [SCHEMA_VERSION]);

  const insReq = db.prepare(
    "INSERT INTO requirements (id, key, seq, status, superseded_by, text, why, source_file, line, spec_version, changed_at_version) " +
      "VALUES ($id, $key, $seq, $status, $sb, $text, NULL, $src, $line, 1, 1)",
  );
  insReq.run({
    id: "AUTH-001",
    key: "AUTH",
    seq: 1,
    status: "Active",
    sb: null,
    text: "Owning requirement; carries the colliding opaque issue id.",
    src: "spec-engine/AUTH/SPEC.md",
    line: 5,
  });
  insReq.run({
    id: "BILLING-001",
    key: "BILLING",
    seq: 1,
    status: "Superseded",
    sb: "BILLING-009",
    text: "A real requirement whose id is reused as an opaque issue id elsewhere.",
    src: "spec-engine/BILLING/SPEC.md",
    line: 5,
  });

  // The opaque issue_id BILLING-001 collides with the real requirement
  // BILLING-001, but is attached to AUTH-001.
  db.prepare(
    "INSERT INTO provenance (req_id, issue_id, role, source_file, line) VALUES ($r, $i, $role, $src, $line)",
  ).run({
    r: "AUTH-001",
    i: "BILLING-001",
    role: "created",
    src: "spec-engine/AUTH/SPEC.md",
    line: 6,
  });

  db.close();
}

describe("issue_id opacity in provenance_matrix VIEW (PROV-02)", () => {
  test("a KEY-NNN-shaped issue id that collides with a real requirement id is NOT routed through that requirement", () => {
    seedColliding(dbPath);
    const s = openStorage(dbPath);
    try {
      const rows = s.provenanceMatrix();
      const row = rows.find((r) => r.req_id === "AUTH-001" && r.issue_id === "BILLING-001");
      expect(row).toBeDefined();

      // The opaque issue id is stored verbatim — never re-shaped or resolved.
      expect(row?.issue_id).toBe("BILLING-001");

      // CRITICAL opacity assertion: req_status is joined on req_id (AUTH-001),
      // NOT on the colliding issue_id (BILLING-001). If issue_id leaked into the
      // join key, this would read "Superseded" (BILLING-001's status).
      expect(row?.req_status).toBe("Active");
      expect(row?.req_status).not.toBe("Superseded");
    } finally {
      s.close();
    }
  });

  test("reverse lookup by the opaque issue id returns the OWNING requirement link, not a requirement resolution", () => {
    seedColliding(dbPath);
    const s = openStorage(dbPath);
    try {
      // provenanceByIssue treats the id as a filter VALUE, never a routing key.
      const hits = s.provenanceByIssue("BILLING-001");
      expect(hits.length).toBe(1);
      expect(hits[0]?.req_id).toBe("AUTH-001");
      expect(hits[0]?.issue_id).toBe("BILLING-001");
      // Still the owning requirement's status — opacity holds on the reverse path.
      expect(hits[0]?.req_status).toBe("Active");
    } finally {
      s.close();
    }
  });

  test("the provenance schema declares no index keyed on issue_id (only req_id)", () => {
    seedColliding(dbPath);
    const db = new Database(dbPath, { readonly: true });
    try {
      // Enumerate every index on the provenance table from the live schema.
      const idx = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'provenance'",
        )
        .all();
      for (const { name } of idx) {
        const info = db
          .query<{ name: string }, [string]>("SELECT name FROM pragma_index_info(?)")
          .all(name);
        const cols = info.map((c) => c.name);
        // No live index may include issue_id as a key column (PROV-02/SC3).
        expect(cols).not.toContain("issue_id");
      }
    } finally {
      db.close();
    }
  });
});
