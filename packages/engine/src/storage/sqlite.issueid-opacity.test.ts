// @spec PROV-007
//
// The issue_id-opacity CI fence proves the source never names issue_id as a
// key; this proves the live view behaves that way. The probe's issue_id
// collides with a real requirement id whose status differs from the owner's,
// so a leak into the join would surface the wrong status.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DDL, SCHEMA_VERSION } from "@spec-engine/shared";
import { openStorage } from "./sqlite";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-prov-opacity-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

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

describe("issue_id opacity in provenance_matrix VIEW", () => {
  test("a KEY-NNN-shaped issue id that collides with a real requirement id is NOT routed through that requirement", () => {
    seedColliding(dbPath);
    const s = openStorage(dbPath);
    try {
      const rows = s.provenanceMatrix();
      const row = rows.find((r) => r.req_id === "AUTH-001" && r.issue_id === "BILLING-001");
      expect(row).toBeDefined();

      expect(row?.issue_id).toBe("BILLING-001");

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
      const hits = s.provenanceByIssue("BILLING-001");
      expect(hits.length).toBe(1);
      expect(hits[0]?.req_id).toBe("AUTH-001");
      expect(hits[0]?.issue_id).toBe("BILLING-001");
      expect(hits[0]?.req_status).toBe("Active");
    } finally {
      s.close();
    }
  });

  test("the provenance schema declares no index keyed on issue_id (only req_id)", () => {
    seedColliding(dbPath);
    const db = new Database(dbPath, { readonly: true });
    try {
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
        expect(cols).not.toContain("issue_id");
      }
    } finally {
      db.close();
    }
  });
});
