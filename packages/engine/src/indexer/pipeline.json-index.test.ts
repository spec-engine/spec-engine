import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InvalidDomainFilesError, type Storage } from "@spec-engine/shared";
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

describe("JSON domain file → internal rows", () => {
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
      expect(pairs("AUTH-001")).toEqual([["created", "BILLING-001"]]);
    } finally {
      s.close();
    }
  });

  test("BILLING-002's planted bad role → UNKNOWN_ROLE, but its well-formed issues still store", async () => {
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: JSON_FIXTURE, storage: s });

      const unknown = s.listDiagnostics().filter((d) => d.code === "UNKNOWN_ROLE");
      expect(unknown.some((d) => d.req_id === "BILLING-002")).toBe(true);

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

/** The refusal `runIndex` throws for `platformDir`, or a failure when it builds. */
async function refusal(platformDir: string, storage: Storage): Promise<InvalidDomainFilesError> {
  try {
    await runIndex({ platformDir, storage });
  } catch (e) {
    if (e instanceof InvalidDomainFilesError) return e;
    throw e;
  }
  throw new Error("runIndex built an index over an invalid SPEC.json");
}

describe("an invalid SPEC.json refuses the build", () => {
  // @spec INDX-016 unit
  test("every invalid file is reported, as INVALID_DOMAIN_FILE rows only", async () => {
    const modFixture = join(tmp, "invalid-json-fixture");
    await platformWithPlantedBilling(modFixture, "missing-id");
    cpSync(join(PLANTED, "not-json", "spec-engine"), join(modFixture, "spec-engine"), {
      recursive: true,
    });
    const s = openStorage(join(tmp, "invalid.sqlite"));
    try {
      const err = await refusal(modFixture, s);
      expect(err.diagnostics.every((d) => d.code === "INVALID_DOMAIN_FILE")).toBe(true);
      expect(err.diagnostics.every((d) => d.severity === "error")).toBe(true);
      expect([...new Set(err.diagnostics.map((d) => d.source_file))].sort()).toEqual([
        "spec-engine/BILLING/SPEC.json",
        "spec-engine/BROKEN/SPEC.json",
      ]);
      expect(err.diagnostics.some((d) => d.detail.includes("not valid JSON"))).toBe(true);
    } finally {
      s.close();
    }
  });

  // @spec INDX-016 unit
  test("a refused build leaves the index on disk as it was", async () => {
    const root = join(tmp, "warm");
    await platformWithPlantedBilling(root, "missing-id");
    rmSync(join(root, "spec-engine", "BILLING"), { recursive: true });
    const fx = TestPlatform.at(root);
    await (await fx.domain("ALPHA")).reqs(2);
    const s = openStorage(join(tmp, "warm.sqlite"));
    try {
      const built = await runIndex({ platformDir: root, storage: s });
      cpSync(join(PLANTED, "not-json", "spec-engine"), join(root, "spec-engine"), {
        recursive: true,
      });
      await refusal(root, s);
      expect(s.listRequirements().map((r) => r.id)).toEqual(["ALPHA-001", "ALPHA-002"]);
      expect(s.listDiagnostics().some((d) => d.code === "INVALID_DOMAIN_FILE")).toBe(false);
      expect(built.requirements).toBe(2);
    } finally {
      s.close();
    }
  });
});

describe("citations populated: build_id byte-identity + deterministic order", () => {
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
      expect(cites.map((c) => [c.req_id, c.term_id, c.cited_as])).toEqual([
        ["BILLING-001", "TERM-001", "TERM-001"],
        ["BILLING-002", "TERM-001", "namespace"],
      ]);
    } finally {
      s.close();
    }
  });
});
