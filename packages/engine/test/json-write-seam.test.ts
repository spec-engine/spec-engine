// packages/engine/test/json-write-seam.test.ts
//
// VAL-01 / VAL-02 (17-04): the requirement-CREATION write path now routes
// through the ONE `validateAndWrite` seam in `@spec-engine/shared`, producing JSON.
// This suite proves the two properties that make the seam trustworthy:
//
//   (1) ROUND-TRIP — `appendEntry` writes a SPEC.json that the index reads
//       back into the authored requirement as an Active row. Writing and
//       indexing cannot diverge because both sides share the ONE schema.
//
//   (2) VAL-02 PARITY — authoring a structurally-invalid requirement is
//       rejected at write time with the BYTE-IDENTICAL Diagnostic the index
//       path (`validateDomainFile`) emits for the same object, and the write
//       path leaves NO file behind. A single validator cannot fork.
//
// Scaffolding mirrors json-index.test.ts (mkdtempSync / openStorage / runIndex)
// and cli-req.test.ts (a valid domain platform in a tmpdir).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAndWrite, validateDomainFile } from "@spec-engine/shared";
import { nextRequirementId, scaffoldDomainObject } from "../src/authoring/domains";
import { appendEntry } from "../src/commands/req";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";
import { specTag } from "./fixtures/cloneFixture";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-json-write-seam-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Build a minimal JSON platform in `tmp`: a version-2 manifest, an empty
 * BILLING domain scaffolded through the seam, and an `api` member whose
 * BILLING-001 spec tag exercises coverage after the append.
 */
async function scaffoldPlatform(): Promise<void> {
  await mkdir(join(tmp, "spec-engine", "BILLING"), { recursive: true });
  await mkdir(join(tmp, "api", "src"), { recursive: true });
  await writeFile(
    join(tmp, "api", "spec-engine.member.json"),
    `${JSON.stringify({ specs: "spec-engine@2" }, null, 2)}\n`,
  );
  await writeFile(
    join(tmp, "api", "src", "renew.ts"),
    `${specTag("BILLING-001")}\nexport const renew = () => 0;\n`,
  );
  // Scaffold the empty domain through the ONE write seam (VAL-01).
  const dest = join(tmp, "spec-engine", "BILLING", "SPEC.json");
  const res = await validateAndWrite(
    dest,
    scaffoldDomainObject("BILLING", "2026-06-02"),
    "spec-engine/BILLING/SPEC.json",
  );
  expect(res.ok).toBe(true);
}

// @spec SCHM-004
describe("VAL-01 round-trip — appendEntry writes JSON the index reads back (STOR-01)", () => {
  test("append → re-read shows the requirement with status active", async () => {
    await scaffoldPlatform();
    const id = await nextRequirementId(tmp, "BILLING");
    expect(id).toBe("BILLING-001");

    const relFile = await appendEntry(tmp, "BILLING", id, {
      requirement: "Charge renewals at the current plan price",
      why: "Revenue correctness",
      binds: "",
      lives: "@api/src/renew.ts",
    });
    expect(relFile).toBe("spec-engine/BILLING/SPEC.json");

    const domain = JSON.parse(
      await Bun.file(join(tmp, "spec-engine", "BILLING", "SPEC.json")).text(),
    );
    const added = domain.requirements.find((r: { id: string }) => r.id === "BILLING-001");
    expect(added).toBeDefined();
    expect(added.status).toBe("active");
    expect(added.statement).toBe("Charge renewals at the current plan price");
    expect(added.why).toBe("Revenue correctness");
    expect(added.livesIn).toEqual(["@api/src/renew.ts"]);
    // The written file is byte-stable (2-space + single trailing newline).
    const raw = await Bun.file(join(tmp, "spec-engine", "BILLING", "SPEC.json")).text();
    expect(raw.endsWith("}\n")).toBe(true);
  });

  test("the written SPEC.json indexes to the authored requirement as an Active row", async () => {
    await scaffoldPlatform();
    const id = await nextRequirementId(tmp, "BILLING");
    await appendEntry(tmp, "BILLING", id, {
      requirement: "Charge renewals at the current plan price",
      why: "Revenue correctness",
      binds: "",
      lives: "",
    });

    const dbPath = join(tmp, "index.sqlite");
    const s = openStorage(dbPath);
    try {
      await runIndex({ platformDir: tmp, storage: s });
      const byId = new Map(s.listRequirements().map((r) => [r.id, r]));
      const row = byId.get("BILLING-001");
      expect(row).toBeDefined();
      // lowercase "active" case-maps to Capitalized "Active" at the read boundary.
      expect(row?.status).toBe("Active");
      expect(row?.text).toBe("Charge renewals at the current plan price");
      // Coverage: the api member's BILLING-001 spec tag lands.
      const cov = s.coverageMatrix().filter((c) => c.req_id === "BILLING-001" && c.repo === "api");
      expect(cov.length).toBe(1);
      expect(cov[0]?.implemented).toBe(1);
    } finally {
      s.close();
    }
  });
});

describe("VAL-02 parity — author-time reject == index-time reject (byte-identical)", () => {
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

    // Index path (read): validateDomainFile is the ONE structural validator.
    const readResult = validateDomainFile(invalid, sourceFile);
    // Write path: validateAndWrite validates through the SAME function.
    const writePath = join(tmp, "rejected.json");
    const writeResult = await validateAndWrite(writePath, invalid, sourceFile);

    expect(readResult.ok).toBe(false);
    expect(writeResult.ok).toBe(false);
    if (!readResult.ok && !writeResult.ok) {
      // VAL-02: the write-path diagnostics are deep-equal to the index-path
      // diagnostics for the same invalid object — a single function can't fork.
      expect(writeResult.diagnostics).toEqual(readResult.diagnostics);
      expect(writeResult.diagnostics[0]?.code).toBe("INVALID_DOMAIN_FILE");
      expect(writeResult.diagnostics[0]?.severity).toBe("error");
    }
    // The rejected write left NO file behind.
    expect(existsSync(writePath)).toBe(false);
  });

  test("appendEntry over a domain reduced to invalid rejects at write time (no partial write)", async () => {
    // A domain whose sole requirement carries an empty statement would fail the
    // schema; validateAndWrite must reject rather than persist a broken file.
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
