// packages/engine/test/json-provenance-roundtrip.test.ts
//
// STOR-01 regression lock: the JSON read path round-trips role-tagged
// `issues[]` provenance LOSSLESSLY over the committed planted-mess JSON fixture
// (`fixtures/json-fixture/`). This pins the exact property Phase 18's
// byte-checked migrate round-trip will depend on:
//
//   1. Full provenance set — created / supersedes-via / amends-via rows land
//      for every requirement that authors an `issues[]`, keyed by
//      (req_id, role, issue_id); nothing else lands.
//   2. Authored order preserved — BILLING-009's two issues read back in the
//      order they were authored (created before supersedes-via).
//   3. issue_id OPACITY — AUTH-001's `created:BILLING-001` stores `BILLING-001`
//      VERBATIM as an opaque issue_id (PROV-02/SC3); it is NEVER resolved to
//      the BILLING-001 requirement and NEVER surfaced as a relation.
//   4. Surface-and-drop — BILLING-002's planted bad-role token yields exactly
//      one warning-severity UNKNOWN_ROLE parse_diagnostics row AND is dropped
//      from provenance, while its two well-formed issues still land
//      (Invariant #4 — validate via diagnostics, never DB constraints).
//   5. Role allow-list — no stored provenance row carries a role outside
//      {created, supersedes-via, amends-via}.
//
// Rows are read back through the storage read methods (listProvenance /
// listDiagnostics / listRelations), exercising the full index → row path — not
// by re-parsing the fixture. Scaffolding mirrors cold-rebuild.test.ts
// (mkdtempSync / openStorage / runIndex + rmSync afterEach).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";

const JSON_FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "json-fixture");

const ALLOWED_ROLES = new Set(["created", "supersedes-via", "amends-via"]);

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-json-prov-roundtrip-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("JSON issues[] provenance round-trip (STOR-01)", () => {
  test("the full provenance set round-trips keyed by (req_id, role, issue_id)", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: JSON_FIXTURE, storage: s });

      // listProvenance is ORDER BY (req_id, role, issue_id, source_file, line),
      // so the whole set is deterministic — assert the exact triples.
      const set = s.listProvenance().map((p) => [p.req_id, p.role, p.issue_id]);
      expect(set).toEqual([
        ["AUTH-001", "created", "BILLING-001"],
        ["BILLING-001", "created", "ENG-1100"],
        ["BILLING-002", "created", "ENG-1"],
        ["BILLING-002", "supersedes-via", "ENG-2"],
        ["BILLING-009", "created", "ENG-1432"],
        ["BILLING-009", "supersedes-via", "ENG-1781"],
      ]);
    } finally {
      s.close();
    }
  });

  test("BILLING-009's two issues preserve authored order (created before supersedes-via)", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: JSON_FIXTURE, storage: s });

      // Authored order in BILLING/SPEC.json is [created:ENG-1432,
      // supersedes-via:ENG-1781]. The pipeline pre-sort key (req_id, role,
      // issue_id) coincides with that authored order here, so the round-trip
      // reads them back in the same order they were written.
      const rows = s
        .listProvenance()
        .filter((p) => p.req_id === "BILLING-009")
        .map((p) => [p.role, p.issue_id]);
      expect(rows).toEqual([
        ["created", "ENG-1432"],
        ["supersedes-via", "ENG-1781"],
      ]);
    } finally {
      s.close();
    }
  });

  test("AUTH-001's opaque issue_id is BILLING-001 verbatim — stored as provenance, never resolved or made a relation", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: JSON_FIXTURE, storage: s });

      const auth = s.listProvenance().filter((p) => p.req_id === "AUTH-001");
      expect(auth).toHaveLength(1);
      // The KEY-NNN-shaped payload stores VERBATIM as an opaque issue_id — it is
      // NOT resolved/joined to the BILLING-001 requirement (PROV-02/SC3).
      expect(auth[0]?.role).toBe("created");
      expect(auth[0]?.issue_id).toBe("BILLING-001");

      // It rode in as provenance, NOT as a `**Relates:**`-style relation: no
      // relation row originates from AUTH-001 (the fixture authors no relates,
      // and issue_id must never leak into the relation graph).
      const relations = s.listRelations();
      expect(relations.some((r) => r.from_id === "AUTH-001")).toBe(false);
      expect(relations.some((r) => r.to_id === "BILLING-001")).toBe(false);
    } finally {
      s.close();
    }
  });

  test("BILLING-002's bad-role token → exactly one warning UNKNOWN_ROLE diagnostic, dropped from provenance; well-formed rows survive (Invariant #4)", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: JSON_FIXTURE, storage: s });

      const unknown = s
        .listDiagnostics()
        .filter((d) => d.code === "UNKNOWN_ROLE" && d.req_id === "BILLING-002");
      expect(unknown).toHaveLength(1);
      expect(unknown[0]?.severity).toBe("warning");
      // T-17-04: the diagnostic points at the platform-relative domain file,
      // never a leaked absolute path.
      expect(unknown[0]?.source_file).toBe("spec-engine/BILLING/SPEC.json");

      // The bad `bogus-role:ENG-9` token was DROPPED from provenance, but the
      // two well-formed issues on the same requirement still landed.
      const prov002 = s
        .listProvenance()
        .filter((p) => p.req_id === "BILLING-002")
        .map((p) => [p.role, p.issue_id]);
      expect(prov002).toEqual([
        ["created", "ENG-1"],
        ["supersedes-via", "ENG-2"],
      ]);
      expect(prov002.some(([, id]) => id === "ENG-9")).toBe(false);
    } finally {
      s.close();
    }
  });

  test("no stored provenance row carries a role outside the closed allow-list", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: JSON_FIXTURE, storage: s });

      for (const p of s.listProvenance()) {
        expect(ALLOWED_ROLES.has(p.role)).toBe(true);
        // T-17-04: every provenance row locates a platform-relative source_file.
        expect(p.source_file.startsWith("/")).toBe(false);
      }
    } finally {
      s.close();
    }
  });
});
