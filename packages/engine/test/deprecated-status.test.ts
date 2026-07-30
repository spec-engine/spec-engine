// packages/engine/test/deprecated-status.test.ts
//
// The Deprecated status (D2 rename from "Retired") and its formerly blind
// spots. A deprecated requirement is end-of-life with no successor; the three
// behaviors here are what makes that status mean something:
//
//   - a code tag on a deprecated requirement is an ERROR diagnostic
//     (DEPRECATED_REFERENCED — the SUPERSEDED_REFERENCED analogue), and
//   - a deprecated requirement never surfaces in live search, and
//   - the legacy authored spelling "retired" still reads as Deprecated
//     (alias on the parse path — old files keep working).
//
// The gate branch (fail reason DEPRECATED) is covered in gate-classify.test.ts.
//
// Verifies:
// @spec CHCK-007 integration
// @spec QURY-004 integration

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Diagnostic, Storage } from "@spec-engine/shared";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let platformDir: string;
let storage: Storage;

beforeEach(() => {
  platformDir = cloneFixture(FIXTURE);
  storage = openStorage(join(platformDir, ".spec-engine", "test-index.sqlite"));
});

afterEach(() => {
  storage.close();
  rmSync(platformDir, { recursive: true, force: true });
});

/** Flip one requirement's authored status in the cloned fixture's SPEC.json. */
function setStatus(key: string, id: string, status: string): void {
  const specPath = join(platformDir, "spec-engine", key, "SPEC.json");
  const doc = JSON.parse(readFileSync(specPath, "utf8"));
  const req = doc.requirements.find((r: { id: string }) => r.id === id);
  req.status = status;
  // A deprecated entry has no successor — drop the supersede link when the
  // flip replaces a fixture-planted Superseded status.
  req.supersededBy = null;
  writeFileSync(specPath, `${JSON.stringify(doc, null, 2)}\n`);
}

async function diagnose(): Promise<Diagnostic[]> {
  await runIndex({ platformDir, storage });
  return storage.listSemanticDiagnostics() as unknown as Diagnostic[];
}

describe("Deprecated status — reference diagnostic, search exclusion, legacy alias", () => {
  test("a code tag on a deprecated requirement fires DEPRECATED_REFERENCED as an error", async () => {
    // BILLING-001 is tagged in mobile/src/billing.ts. Deprecated instead of
    // Superseded, the tag must fire the analogous error — not vanish.
    setStatus("BILLING", "BILLING-001", "deprecated");
    const rows = await diagnose();
    const hit = rows.find((d) => d.code === "DEPRECATED_REFERENCED");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("error");
    expect(hit?.req_id).toBe("BILLING-001");
    expect(hit?.repo).toBe("mobile");
    // The superseded diagnostic no longer claims this row.
    expect(rows.some((d) => d.code === "SUPERSEDED_REFERENCED" && d.req_id === "BILLING-001")).toBe(
      false,
    );
  });

  test("a deprecated requirement is excluded from live search", async () => {
    // AUTH-001 is Active and searchable; deprecated, the same query is empty.
    await runIndex({ platformDir, storage });
    expect(storage.searchFts("session expires").some((h) => h.req_id === "AUTH-001")).toBe(true);

    setStatus("AUTH", "AUTH-001", "deprecated");
    await runIndex({ platformDir, storage });
    expect(storage.searchFts("session expires").some((h) => h.req_id === "AUTH-001")).toBe(false);
  });

  test("the legacy authored spelling 'retired' reads as Deprecated", async () => {
    setStatus("AUTH", "AUTH-001", "retired");
    const rows = await diagnose();
    // No BAD_STATUS for the legacy spelling…
    expect(rows.some((d) => d.code === "BAD_STATUS" && d.req_id === "AUTH-001")).toBe(false);
    // …and the row carries the Deprecated status downstream (search excludes it).
    expect(storage.searchFts("session expires").some((h) => h.req_id === "AUTH-001")).toBe(false);
  });
});
