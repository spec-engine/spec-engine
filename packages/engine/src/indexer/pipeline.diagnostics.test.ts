import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStorage } from "../storage/sqlite";
import { runIndex } from "./pipeline";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-semantic-diag-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("listSemanticDiagnostics against canonical fixture", () => {
  test("DANGLING_TAG fires for admin/BILLING-999", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
      const rows = s.listSemanticDiagnostics();
      const hit = rows.find(
        (d) => d.code === "DANGLING_TAG" && d.repo === "admin" && d.req_id === "BILLING-999",
      );
      expect(hit).toBeDefined();
      expect(hit?.source_file).toBe("admin/src/reports.ts");
    } finally {
      s.close();
    }
  });

  test("SUPERSEDED_REFERENCED fires for mobile/BILLING-001", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
      const rows = s.listSemanticDiagnostics();
      const hit = rows.find(
        (d) =>
          d.code === "SUPERSEDED_REFERENCED" && d.repo === "mobile" && d.req_id === "BILLING-001",
      );
      expect(hit).toBeDefined();
      expect(hit?.detail).toContain("BILLING-009");
    } finally {
      s.close();
    }
  });

  test("DRIFT row matches drift VIEW positive case (mobile/BILLING-001)", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
      const rows = s.listSemanticDiagnostics();
      const hit = rows.find(
        (d) => d.code === "DRIFT" && d.repo === "mobile" && d.req_id === "BILLING-001",
      );
      expect(hit).toBeDefined();
      expect(hit?.detail).toContain("@1");
      expect(hit?.detail).toContain("@2");
    } finally {
      s.close();
    }
  });

  test("ORPHAN_REQ fires for AUTH-001 with repo=null", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
      const rows = s.listSemanticDiagnostics();
      const hit = rows.find((d) => d.code === "ORPHAN_REQ" && d.req_id === "AUTH-001");
      expect(hit).toBeDefined();
      expect(hit?.repo).toBeNull();
      expect(hit?.source_file).toContain("AUTH/SPEC.json");
    } finally {
      s.close();
    }
  });

  test("UNVERIFIED_REQ fires for BILLING-002 with repo=null", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
      const rows = s.listSemanticDiagnostics();
      const hit = rows.find((d) => d.code === "UNVERIFIED_REQ" && d.req_id === "BILLING-002");
      expect(hit).toBeDefined();
      expect(hit?.repo).toBeNull();
      expect(hit?.source_file).toContain("BILLING/SPEC.json");
    } finally {
      s.close();
    }
  });

  test("BILLING-001 (Superseded) does NOT fire ORPHAN_REQ", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
      const rows = s.listSemanticDiagnostics();
      const hits = rows.filter((d) => d.code === "ORPHAN_REQ" && d.req_id === "BILLING-001");
      expect(hits.length).toBe(0);
    } finally {
      s.close();
    }
  });

  test("BILLING-007 has src+test tags → no UNVERIFIED_REQ", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
      const rows = s.listSemanticDiagnostics();
      const hits = rows.filter((d) => d.code === "UNVERIFIED_REQ" && d.req_id === "BILLING-007");
      expect(hits.length).toBe(0);
    } finally {
      s.close();
    }
  });

  test("exact diagnostic set against canonical fixture", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
      const rows = s.listSemanticDiagnostics();
      const norm = rows.map((d) => `${d.code}\t${d.repo ?? ""}\t${d.req_id ?? ""}`).sort();
      expect(norm).toEqual([
        "DANGLING_TAG\tadmin\tBILLING-999",
        "DRIFT\tmobile\tBILLING-001",
        "ORPHAN_REQ\t\tAUTH-001",
        "SUPERSEDED_REFERENCED\tmobile\tBILLING-001",
        "UNVERIFIED_REQ\t\tBILLING-002",
      ]);
    } finally {
      s.close();
    }
  });

  test("severity matches the per-code contract", async () => {
    // @spec CHCK-035 unit
    const WARNING_CODES = new Set(["BROKEN_RELATES", "RELATES_SUPERSEDED", "UNVERIFIED_REQ"]);
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
      const rows = s.listSemanticDiagnostics();
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.severity).toBe(WARNING_CODES.has(r.code) ? "warning" : "error");
      }
    } finally {
      s.close();
    }
  });

  test("source_file is platform-relative, never absolute", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: FIXTURE, storage: s });
      const rows = s.listSemanticDiagnostics();
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.source_file.startsWith("/")).toBe(false);
      }
    } finally {
      s.close();
    }
  });
});
