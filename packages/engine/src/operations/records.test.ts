// packages/engine/src/operations/records.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { runIndex } from "../indexer/pipeline";
import { openStorage } from "../storage/sqlite";
import { cloneFixture } from "../testing/cloneFixture";
import { getRecord, listRecords, requirementStatus, STATUS_WORDS } from "./records";

const FIXTURE = join(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

let platformDir: string;
let storage: Storage;

beforeAll(async () => {
  platformDir = cloneFixture(FIXTURE);
  storage = openStorage(join(platformDir, ".spec-engine", "index.sqlite"));
  await runIndex({ platformDir, storage });
});

afterAll(() => {
  storage.close();
  rmSync(platformDir, { recursive: true, force: true });
});

// @spec MAP-003 unit
describe("getRecord", () => {
  test("a known id answers its full record", () => {
    const r = getRecord(storage, "BILLING-009");
    expect(r.row?.id).toBe("BILLING-009");
    expect(r.row?.status).toBe("Active");
    expect(r.row?.key).toBe("BILLING");
    expect(r.row?.seq).toBe(9);
    expect(typeof r.row?.text).toBe("string");
    expect(r.platformEmpty).toBe(false);
  });

  test("an unknown id answers null without inventing a row", () => {
    const r = getRecord(storage, "BILLING-999");
    expect(r.row).toBeNull();
    expect(r.platformEmpty).toBe(false);
  });
});

// @spec MAP-004 unit
describe("listRecords", () => {
  test("unfiltered: every record in (key, seq) order, history included", () => {
    const { rows } = listRecords(storage);
    expect(rows.length).toBeGreaterThan(1);
    const keys = rows.map((r) => `${r.key}-${String(r.seq).padStart(6, "0")}`);
    expect(keys).toEqual([...keys].sort());
    expect(rows.some((r) => r.status === "Superseded")).toBe(true);
  });

  test("--status superseded includes BILLING-001; --domain narrows to one key", () => {
    const superseded = listRecords(storage, { status: "Superseded" }).rows;
    expect(superseded.map((r) => r.id)).toContain("BILLING-001");
    expect(superseded.every((r) => r.status === "Superseded")).toBe(true);
    const billing = listRecords(storage, { key: "BILLING" }).rows;
    expect(billing.length).toBeGreaterThan(0);
    expect(billing.every((r) => r.key === "BILLING")).toBe(true);
  });
});

describe("requirementStatus", () => {
  test("resolves any case of the four stored statuses and nothing else", () => {
    expect(requirementStatus("active")).toBe("Active");
    expect(requirementStatus("SUPERSEDED")).toBe("Superseded");
    expect(requirementStatus(" Draft ")).toBe("Draft");
    expect(requirementStatus("deprecated")).toBe("Deprecated");
    for (const word of STATUS_WORDS) expect(requirementStatus(word)).not.toBeNull();
    expect(requirementStatus("retired")).toBeNull();
    expect(requirementStatus("")).toBeNull();
  });
});
