import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStorage } from "../storage/sqlite";
import { runIndex } from "./pipeline";

const JSON_FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "json-fixture");

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

describe("JSON issues[] provenance round-trip", () => {
  test("the full provenance set round-trips keyed by (req_id, role, issue_id)", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: JSON_FIXTURE, storage: s });

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

  test("BILLING-009's two issues read back created before supersedes-via", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: JSON_FIXTURE, storage: s });

      // The (req_id, role, issue_id) sort happens to match the authored order
      // here; it does not preserve authored order in general.
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

  // @spec PROV-005 unit
  test("AUTH-001's opaque issue_id is BILLING-001 verbatim — stored as provenance, never resolved or made a relation", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: JSON_FIXTURE, storage: s });

      const auth = s.listProvenance().filter((p) => p.req_id === "AUTH-001");
      expect(auth).toHaveLength(1);
      expect(auth[0]?.role).toBe("created");
      expect(auth[0]?.issue_id).toBe("BILLING-001");

      const relations = s.listRelations();
      expect(relations.some((r) => r.from_id === "AUTH-001")).toBe(false);
      expect(relations.some((r) => r.to_id === "BILLING-001")).toBe(false);
    } finally {
      s.close();
    }
  });

  test("BILLING-002's bad-role token → exactly one warning UNKNOWN_ROLE diagnostic, dropped from provenance; well-formed rows survive", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: JSON_FIXTURE, storage: s });

      const unknown = s
        .listDiagnostics()
        .filter((d) => d.code === "UNKNOWN_ROLE" && d.req_id === "BILLING-002");
      expect(unknown).toHaveLength(1);
      expect(unknown[0]?.severity).toBe("warning");
      expect(unknown[0]?.source_file).toBe("spec-engine/BILLING/SPEC.json");

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
        expect(p.source_file.startsWith("/")).toBe(false);
      }
    } finally {
      s.close();
    }
  });
});
