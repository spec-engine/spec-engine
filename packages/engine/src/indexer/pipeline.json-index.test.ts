// packages/engine/src/indexer/pipeline.json-index.test.ts
//
// STOR-01/STOR-02/STOR-03 (17-02, Task 3): end-to-end integration over the
// committed planted-mess JSON fixture (`fixtures/json-fixture/`, a SEPARATE tree
// from the Markdown `fixtures/platform-fixture/`). Proves:
//   - a JSON domain file indexes into the correct internal rows (requirements,
//     provenance) with lowercase statuses case-mapped to Capitalized;
//   - the opaque KEY-NNN issue id (AUTH-001 created:BILLING-001) stores verbatim;
//   - a planted bad issue role (BILLING-002 bogus-role) yields a UNKNOWN_ROLE
//     diagnostic AND its well-formed issues still store (Invariant #4);
//   - coverage is exercised — the api member's BILLING-009 spec tag lands;
//   - a structurally-invalid SPEC.json is rejected LOUDLY as an error-severity
//     INVALID_DOMAIN_FILE and contributes ZERO requirements (STOR-03) — no
//     silent-zero, no crash.
//
// Scaffolding mirrors cold-rebuild.test.ts (mkdtempSync / openStorage / runIndex).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStorage } from "../storage/sqlite";
import { specTag } from "../testing/cloneFixture";
import { TestPlatform } from "../testing/platform";
import { runIndex } from "./pipeline";

const JSON_FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "json-fixture");
const PLANTED = join(import.meta.dir, "..", "testing", "fixtures", "diagnostics");

/** A platform whose `api` member tags BILLING-009, with a planted (invalid) BILLING spec copied over it. */
async function platformWithPlantedBilling(root: string, planted: string): Promise<void> {
  const fx = TestPlatform.at(root);
  await fx.member("api", {
    pin: "spec-engine@2",
    files: { "src/renew.ts": `${specTag("BILLING-009")}\nexport const renew = () => 0;\n` },
  });
  cpSync(join(PLANTED, planted, "spec-engine"), join(root, "spec-engine"), { recursive: true });
}

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-json-index-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("JSON domain file → internal rows (STOR-01/STOR-02)", () => {
  test("requirements land with lowercase statuses case-mapped to Capitalized", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: JSON_FIXTURE, storage: s });
      const byId = new Map(s.listRequirements().map((r) => [r.id, r]));

      expect([...byId.keys()].sort()).toEqual([
        "AUTH-001",
        "BILLING-001",
        "BILLING-002",
        "BILLING-007",
        "BILLING-009",
      ]);
      expect(byId.get("BILLING-001")?.status).toBe("Superseded");
      expect(byId.get("BILLING-001")?.superseded_by).toBe("BILLING-009");
      expect(byId.get("BILLING-009")?.status).toBe("Active");
      expect(byId.get("BILLING-002")?.status).toBe("Active");
      expect(byId.get("BILLING-007")?.status).toBe("Active");
      expect(byId.get("AUTH-001")?.status).toBe("Active");
      // statement → text mapping is lossless
      expect(byId.get("AUTH-001")?.text).toBe("A session expires 30 days after last activity.");
    } finally {
      s.close();
    }
  });

  test("provenance rows land in the right roles; opaque KEY-NNN issue id stored verbatim", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: JSON_FIXTURE, storage: s });
      const prov = s.listProvenance();
      const pairs = (reqId: string) =>
        prov
          .filter((p) => p.req_id === reqId)
          .map((p) => [p.role, p.issue_id])
          .sort();

      expect(pairs("BILLING-001")).toEqual([["created", "ENG-1100"]]);
      expect(pairs("BILLING-009")).toEqual([
        ["created", "ENG-1432"],
        ["supersedes-via", "ENG-1781"],
      ]);
      // Opaque KEY-NNN-shaped issue id stored verbatim (PROV-02) — never resolved.
      expect(pairs("AUTH-001")).toEqual([["created", "BILLING-001"]]);
    } finally {
      s.close();
    }
  });

  test("BILLING-002's planted bad role → UNKNOWN_ROLE, but its well-formed issues still store (Invariant #4)", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: JSON_FIXTURE, storage: s });

      const unknown = s.listDiagnostics().filter((d) => d.code === "UNKNOWN_ROLE");
      expect(unknown.some((d) => d.req_id === "BILLING-002")).toBe(true);

      // The two well-formed issues on BILLING-002 still landed.
      const prov002 = s
        .listProvenance()
        .filter((p) => p.req_id === "BILLING-002")
        .map((p) => [p.role, p.issue_id])
        .sort();
      expect(prov002).toEqual([
        ["created", "ENG-1"],
        ["supersedes-via", "ENG-2"],
      ]);
    } finally {
      s.close();
    }
  });

  test("coverage is exercised — the api member's BILLING-009 spec tag lands", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: JSON_FIXTURE, storage: s });
      const cov = s.coverageMatrix().filter((c) => c.req_id === "BILLING-009" && c.repo === "api");
      expect(cov.length).toBe(1);
      expect(cov[0]?.implemented).toBe(1);
    } finally {
      s.close();
    }
  });
});

describe("structurally-invalid SPEC.json is rejected LOUDLY (STOR-03)", () => {
  test("a requirement missing id → error-severity INVALID_DOMAIN_FILE + ZERO requirements for that domain", async () => {
    // A tmp platform with ONE planted invalid SPEC.json (a requirement missing
    // its `id` — a structural reject) plus a minimal member so discoverRepos
    // succeeds.
    const modFixture = join(tmp, "invalid-json-fixture");
    await platformWithPlantedBilling(modFixture, "missing-id");

    const modDbPath = join(tmp, "invalid.sqlite");
    const s = openStorage(modDbPath);
    try {
      await runIndex({ platformDir: modFixture, storage: s });

      const invalid = s.listDiagnostics().filter((d) => d.code === "INVALID_DOMAIN_FILE");
      expect(invalid.length).toBeGreaterThan(0);
      expect(invalid.every((d) => d.severity === "error")).toBe(true);
      expect(invalid[0]?.source_file).toBe("spec-engine/BILLING/SPEC.json");

      // ZERO requirements from the rejected domain — not a silent-zero, LOUD.
      expect(s.listRequirements({ key: "BILLING" })).toEqual([]);
    } finally {
      s.close();
    }
  });

  test("a non-JSON SPEC.json body → error-severity INVALID_DOMAIN_FILE, not a crash", async () => {
    const modFixture = join(tmp, "nonjson-fixture");
    await platformWithPlantedBilling(modFixture, "not-json");

    const modDbPath = join(tmp, "nonjson.sqlite");
    const s = openStorage(modDbPath);
    try {
      await runIndex({ platformDir: modFixture, storage: s });
      const invalid = s.listDiagnostics().filter((d) => d.code === "INVALID_DOMAIN_FILE");
      expect(invalid.length).toBe(1);
      expect(invalid[0]?.severity).toBe("error");
      expect(invalid[0]?.detail).toContain("not valid JSON");
      expect(s.listRequirements()).toEqual([]);
    } finally {
      s.close();
    }
  });
});

// TERM-03 (Phase 6, Wave C): with `cites` POPULATED (not the present-and-empty
// Wave-A state), cold-rebuild build_id stays byte-identical and listTermCitations
// returns rows in the deterministic composite-key order the storage/build_id
// sections use. Determinism is the T-06-08 tampering mitigation — a scan-order-
// dependent resolution would flip the hash here.
describe("citations populated: build_id byte-identity + deterministic order (TERM-03)", () => {
  function removeDbAndWalSiblings(path: string): void {
    for (const sfx of ["", "-wal", "-shm"]) {
      const p = path + sfx;
      if (existsSync(p)) rmSync(p);
    }
  }

  async function writeCitesFixture(root: string): Promise<void> {
    const fx = TestPlatform.at(root);
    await fx.terms();
    await fx.term({
      term: "Domain",
      definition: "Domain — a bounded area of the spec taxonomy.",
      aliases: ["namespace"],
    });
    const billing = await fx.domain("BILLING", { owner: "drea" });
    await billing.req({
      statement: "A charge belongs to exactly one billing Domain.",
      cites: [{ term: "TERM-001", pinned: 1 }],
    });
    await billing.req({
      statement: "Every invoice names its Domain.",
      cites: [{ term: "namespace", pinned: 1 }],
    });
    await fx.member("api", { files: { "src/noop.ts": "export const noop = () => 0;\n" } });
  }

  test("cold rebuild twice → build_id byte-identical with populated citations", async () => {
    const fixture = join(tmp, "cites-buildid-fixture");
    await writeCitesFixture(fixture);

    const s1 = openStorage(dbPath);
    const a = await runIndex({ platformDir: fixture, storage: s1 });
    s1.close();

    removeDbAndWalSiblings(dbPath);
    const s2 = openStorage(dbPath);
    const c = await runIndex({ platformDir: fixture, storage: s2 });
    s2.close();

    expect(c.build_id).toBe(a.build_id);
    expect(a.build_id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("listTermCitations returns rows ordered deterministically (req_id, term_id, cited_as, …)", async () => {
    const fixture = join(tmp, "cites-order-fixture");
    await writeCitesFixture(fixture);
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: fixture, storage: s });
      const cites = s.listTermCitations();
      // Both cites resolve to TERM-001 (one by id, one by the "namespace" alias),
      // ordered by req_id.
      expect(cites.map((c) => [c.req_id, c.term_id, c.cited_as])).toEqual([
        ["BILLING-001", "TERM-001", "TERM-001"],
        ["BILLING-002", "TERM-001", "namespace"],
      ]);
    } finally {
      s.close();
    }
  });
});
