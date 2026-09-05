// packages/engine/src/check/supersedes.test.ts
//
// The `supersedes` forward-pointer validation (check/supersedes.ts). The loss
// gates honor a non-null `supersedes` as a removal exemption, so it must name
// a real requirement other than the declaring entry.
//
// Verifies:
// @spec CHCK-029 unit

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supersedesPointerDiagnostics } from "./supersedes";

let platformDir: string;

beforeEach(() => {
  platformDir = mkdtempSync(join(tmpdir(), "spec-supersedes-"));
});

afterEach(() => {
  rmSync(platformDir, { recursive: true, force: true });
});

function writeDomain(key: string, requirements: Array<Record<string, unknown>>): void {
  mkdirSync(join(platformDir, "spec-engine", key), { recursive: true });
  writeFileSync(
    join(platformDir, "spec-engine", key, "SPEC.json"),
    `${JSON.stringify(
      { key, owner: null, specVersion: 1, updated: "2026-08-16", requirements },
      null,
      2,
    )}\n`,
  );
}

function req(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "BILLING-001",
    status: "active",
    statement: "The system shall charge a renewal.",
    why: "Revenue.",
    supersedes: null,
    supersededBy: null,
    livesIn: [],
    issues: [],
    ...over,
  };
}

describe("supersedes forward pointer", () => {
  test("a null pointer reports nothing", async () => {
    writeDomain("BILLING", [req({})]);
    expect(await supersedesPointerDiagnostics(platformDir)).toEqual([]);
  });

  test("a pointer at an id that does not exist reports BROKEN_SUPERSEDE", async () => {
    writeDomain("BILLING", [req({ id: "BILLING-002", supersedes: "BILLING-999" })]);
    const rows = await supersedesPointerDiagnostics(platformDir);
    expect(rows.length).toBe(1);
    expect(rows[0].code).toBe("BROKEN_SUPERSEDE");
    expect(rows[0].severity).toBe("error");
    expect(rows[0].req_id).toBe("BILLING-002");
    expect(rows[0].detail).toContain("BILLING-999");
  });

  test("a self-referential pointer reports BROKEN_SUPERSEDE", async () => {
    writeDomain("BILLING", [req({ id: "BILLING-002", supersedes: "BILLING-002" })]);
    const rows = await supersedesPointerDiagnostics(platformDir);
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toContain("itself");
  });

  test("a pointer at an existing requirement in another domain resolves", async () => {
    writeDomain("BILLING", [req({ id: "BILLING-001" })]);
    writeDomain("AUTH", [req({ id: "AUTH-001", supersedes: "BILLING-001" })]);
    expect(await supersedesPointerDiagnostics(platformDir)).toEqual([]);
  });

  test("the pass does not require the target to point back", async () => {
    // The legal delete-and-replace path leaves no predecessor to carry the
    // return pointer, which is why the backward direction exists at all.
    writeDomain("BILLING", [
      req({ id: "BILLING-001", supersededBy: null }),
      req({ id: "BILLING-002", supersedes: "BILLING-001" }),
    ]);
    expect(await supersedesPointerDiagnostics(platformDir)).toEqual([]);
  });
});
