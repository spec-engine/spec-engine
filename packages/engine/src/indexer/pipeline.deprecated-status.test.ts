// The gate's DEPRECATED fail reason is covered in gate-classify.test.ts.
//
// @spec CHCK-007 integration
// @spec QURY-010 integration

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Diagnostic, Storage } from "@spec-engine/shared";
import { openStorage } from "../storage/sqlite";
import { cloneFixture } from "../testing/cloneFixture";
import { entryOf, plantEdit } from "../testing/plant";
import { runIndex } from "./pipeline";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

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

function setStatus(key: string, id: string, status: string): Promise<void> {
  return plantEdit(platformDir, key, (doc) => {
    const req = entryOf(doc, id);
    req.status = status;
    // A deprecated entry has no successor, and the fixture plants a
    // Superseded one.
    req.supersededBy = null;
  });
}

async function diagnose(): Promise<Diagnostic[]> {
  await runIndex({ platformDir, storage });
  return storage.listSemanticDiagnostics() as unknown as Diagnostic[];
}

describe("Deprecated status — reference diagnostic, search exclusion, legacy alias", () => {
  test("a code tag on a deprecated requirement fires DEPRECATED_REFERENCED as an error", async () => {
    // BILLING-001 is tagged in mobile/src/billing.ts.
    await setStatus("BILLING", "BILLING-001", "deprecated");
    const rows = await diagnose();
    const hit = rows.find((d) => d.code === "DEPRECATED_REFERENCED");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("error");
    expect(hit?.req_id).toBe("BILLING-001");
    expect(hit?.repo).toBe("mobile");
    expect(rows.some((d) => d.code === "SUPERSEDED_REFERENCED" && d.req_id === "BILLING-001")).toBe(
      false,
    );
  });

  test("a deprecated requirement is excluded from live search", async () => {
    await runIndex({ platformDir, storage });
    expect(storage.searchFts("session expires").some((h) => h.req_id === "AUTH-001")).toBe(true);

    await setStatus("AUTH", "AUTH-001", "deprecated");
    await runIndex({ platformDir, storage });
    expect(storage.searchFts("session expires").some((h) => h.req_id === "AUTH-001")).toBe(false);
  });

  test("the legacy authored spelling 'retired' reads as Deprecated", async () => {
    await setStatus("AUTH", "AUTH-001", "retired");
    const rows = await diagnose();
    expect(rows.some((d) => d.code === "BAD_STATUS" && d.req_id === "AUTH-001")).toBe(false);
    expect(storage.searchFts("session expires").some((h) => h.req_id === "AUTH-001")).toBe(false);
  });
});
