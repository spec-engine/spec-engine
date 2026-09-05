// packages/engine/src/check/supersedes.test.ts
//
// The `supersedes` forward-pointer validation (check/supersedes.ts). The loss
// gates honor a non-null `supersedes` as a removal exemption, so it must name
// a real requirement other than the declaring entry. No operation authors a
// forward pointer (the delete-and-replace path is manual), so each pointer is
// planted through the seam.
//
// Verifies:
// @spec CHCK-029 unit

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { entryOf, plantEdit } from "../testing/plant";
import { type DomainHandle, TestPlatform } from "../testing/platform";
import { supersedesPointerDiagnostics } from "./supersedes";

let fx: TestPlatform;
let platformDir: string;
let billing: DomainHandle;

beforeEach(async () => {
  fx = TestPlatform.temp("spec-supersedes-");
  platformDir = fx.dir;
  billing = await fx.domain("BILLING");
});

afterEach(() => {
  fx.remove();
});

const STATEMENT = "The system shall charge a renewal.";

function pointAt(key: string, id: string, target: string): Promise<void> {
  return plantEdit(platformDir, key, (d) => {
    entryOf(d, id).supersedes = target;
  });
}

describe("supersedes forward pointer", () => {
  test("a null pointer reports nothing", async () => {
    await billing.req({ statement: STATEMENT, why: "Revenue." });
    expect(await supersedesPointerDiagnostics(platformDir)).toEqual([]);
  });

  test("a pointer at an id that does not exist reports BROKEN_SUPERSEDE", async () => {
    await billing.reqs(2);
    await pointAt("BILLING", "BILLING-002", "BILLING-999");
    const rows = await supersedesPointerDiagnostics(platformDir);
    expect(rows.length).toBe(1);
    expect(rows[0].code).toBe("BROKEN_SUPERSEDE");
    expect(rows[0].severity).toBe("error");
    expect(rows[0].req_id).toBe("BILLING-002");
    expect(rows[0].detail).toContain("BILLING-999");
  });

  test("a self-referential pointer reports BROKEN_SUPERSEDE", async () => {
    await billing.reqs(2);
    await pointAt("BILLING", "BILLING-002", "BILLING-002");
    const rows = await supersedesPointerDiagnostics(platformDir);
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toContain("itself");
  });

  test("a pointer at an existing requirement in another domain resolves", async () => {
    await billing.req();
    const auth = await fx.domain("AUTH");
    await auth.req();
    await pointAt("AUTH", "AUTH-001", "BILLING-001");
    expect(await supersedesPointerDiagnostics(platformDir)).toEqual([]);
  });

  test("the pass does not require the target to point back", async () => {
    // The legal delete-and-replace path leaves no predecessor to carry the
    // return pointer, which is why the backward direction exists at all.
    await billing.reqs(2);
    await pointAt("BILLING", "BILLING-002", "BILLING-001");
    expect(await supersedesPointerDiagnostics(platformDir)).toEqual([]);
  });
});
