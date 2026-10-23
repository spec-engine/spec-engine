import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAndWrite, validateDomainFile } from "@spec-engine/shared";
import { nextRequirementId } from "../authoring/domains";
import { runIndex } from "../indexer/pipeline";
import { openStorage } from "../storage/sqlite";
import { specTag } from "../testing/cloneFixture";
import { TestPlatform } from "../testing/platform";
import { mint } from "./mint";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-json-write-seam-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function scaffoldPlatform(): Promise<void> {
  const fx = TestPlatform.at(tmp);
  await fx.domain("BILLING");
  await fx.member("api", {
    pin: "spec-engine@2",
    files: { "src/renew.ts": `${specTag("BILLING-001")}\nexport const renew = () => 0;\n` },
  });
}

// @spec SCHM-015
describe("round-trip: mint writes JSON the index reads back", () => {
  test("append → re-read shows the requirement with status active", async () => {
    await scaffoldPlatform();
    const id = await nextRequirementId(tmp, "BILLING");
    expect(id).toBe("BILLING-001");

    const minted = await mint({
      platformDir: tmp,
      key: "BILLING",
      statement: "Charge renewals at the current plan price.",
      why: "Revenue correctness",
      livesIn: ["@api/src/renew.ts"],
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.id).toBe(id);
    expect(minted.file).toBe("spec-engine/BILLING/SPEC.json");

    const domain = JSON.parse(
      await Bun.file(join(tmp, "spec-engine", "BILLING", "SPEC.json")).text(),
    );
    const added = domain.requirements.find((r: { id: string }) => r.id === "BILLING-001");
    expect(added).toBeDefined();
    expect(added.status).toBe("active");
    expect(added.statement).toBe("Charge renewals at the current plan price.");
    expect(added.why).toBe("Revenue correctness");
    expect(added.livesIn).toEqual(["@api/src/renew.ts"]);
    const raw = await Bun.file(join(tmp, "spec-engine", "BILLING", "SPEC.json")).text();
    expect(raw.endsWith("}\n")).toBe(true);
  });

  test("the written SPEC.json indexes to the authored requirement as an Active row", async () => {
    await scaffoldPlatform();
    const id = await nextRequirementId(tmp, "BILLING");
    const minted = await mint({
      platformDir: tmp,
      key: "BILLING",
      statement: "Charge renewals at the current plan price.",
      why: "Revenue correctness",
      livesIn: [],
    });
    expect(minted.ok && minted.id === id).toBe(true);

    const dbPath = join(tmp, "index.sqlite");
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: tmp, storage: s });
      const byId = new Map(s.listRequirements().map((r) => [r.id, r]));
      const row = byId.get("BILLING-001");
      expect(row).toBeDefined();
      // lowercase "active" case-maps to Capitalized "Active" at the read boundary.
      expect(row?.status).toBe("Active");
      expect(row?.text).toBe("Charge renewals at the current plan price.");
      const cov = s.coverageMatrix().filter((c) => c.req_id === "BILLING-001" && c.repo === "api");
      expect(cov.length).toBe(1);
      expect(cov[0]?.implemented).toBe(1);
    } finally {
      s.close();
    }
  });
});

describe("parity: author-time reject == index-time reject (byte-identical)", () => {
  test("a structurally-invalid requirement yields IDENTICAL diagnostics on both paths, and writes nothing", async () => {
    const sourceFile = "spec-engine/BILLING/SPEC.json";
    // `statement: ""` fails the schema's z.string().min(1) — a structural reject.
    const invalid = {
      key: "BILLING",
      owner: null,
      specVersion: 1,
      updated: "2026-07-01",
      requirements: [{ id: "BILLING-001", status: "active", statement: "" }],
    };

    const readResult = validateDomainFile(invalid, sourceFile);
    const writePath = join(tmp, "rejected.json");
    const writeResult = await validateAndWrite(writePath, invalid, sourceFile);

    expect(readResult.ok).toBe(false);
    expect(writeResult.ok).toBe(false);
    if (!readResult.ok && !writeResult.ok) {
      expect(writeResult.diagnostics).toEqual(readResult.diagnostics);
      expect(writeResult.diagnostics[0]?.code).toBe("INVALID_DOMAIN_FILE");
      expect(writeResult.diagnostics[0]?.severity).toBe("error");
    }
    expect(existsSync(writePath)).toBe(false);
  });

  test("a domain reduced to invalid rejects at write time (no partial write)", async () => {
    const sourceFile = "spec-engine/BILLING/SPEC.json";
    const invalid = {
      key: "BILLING",
      owner: null,
      specVersion: 1,
      updated: "2026-07-01",
      requirements: [{ id: "BILLING-bad", status: "active", statement: "x" }],
    };
    // `BILLING-bad` violates ID_RE (/^[A-Z][A-Z0-9]*-\d+$/) — a structural reject.
    const writePath = join(tmp, "badid.json");
    const res = await validateAndWrite(writePath, invalid, sourceFile);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.diagnostics.every((d) => d.code === "INVALID_DOMAIN_FILE")).toBe(true);
    }
    expect(existsSync(writePath)).toBe(false);
  });
});
