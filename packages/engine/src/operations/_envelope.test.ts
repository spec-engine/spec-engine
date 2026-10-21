import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryOf, plantEdit } from "../testing/plant";
import { TestPlatform } from "../testing/platform";
import { locateEntry, readEnvelope } from "./_envelope";

const PLANTED = join(import.meta.dir, "../testing/fixtures/diagnostics");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-envelope-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// @spec SCHM-030 unit
describe("readEnvelope — every SPEC.json read goes through the shared schema", () => {
  test("an authored domain reads back as a typed envelope with defaults applied", async () => {
    const fx = TestPlatform.at(tmp);
    const billing = await fx.domain("BILLING");
    await billing.req({ statement: "The billing service shall charge the current price." });
    const file = await readEnvelope(tmp, "BILLING");
    expect(file.ok).toBe(true);
    if (!file.ok) throw new Error("expected a readable envelope");
    expect(file.key).toBe("BILLING");
    expect(file.relFile).toBe("spec-engine/BILLING/SPEC.json");
    expect(file.requirements).toBe(file.domain.requirements);
    expect(file.requirements[0]?.id).toBe("BILLING-001");
    expect(file.requirements[0]?.relates).toEqual([]);
    expect(file.requirements[0]?.cites).toEqual([]);
  });

  test("a missing domain is not_found with the shared wording", async () => {
    TestPlatform.at(tmp);
    const file = await readEnvelope(tmp, "BILLING");
    expect(file.ok).toBe(false);
    if (file.ok) throw new Error("expected a refusal");
    expect(file.reason).toBe("not_found");
    expect(file.detail).toBe(
      `no domain BILLING (expected spec-engine/BILLING/SPEC.json under ${tmp})`,
    );
  });

  test("bytes that are not JSON are invalid_domain_file with no diagnostics", async () => {
    const file = await readEnvelope(join(PLANTED, "not-json"), "BROKEN");
    expect(file.ok).toBe(false);
    if (file.ok) throw new Error("expected a refusal");
    expect(file.reason).toBe("invalid_domain_file");
    expect(file.detail).toBe("spec-engine/BROKEN/SPEC.json is not valid JSON");
    expect(file.diagnostics).toBeUndefined();
  });

  test("JSON the schema rejects is invalid_domain_file carrying the validator's diagnostics", async () => {
    const file = await readEnvelope(join(PLANTED, "missing-id"), "BILLING");
    expect(file.ok).toBe(false);
    if (file.ok) throw new Error("expected a refusal");
    expect(file.reason).toBe("invalid_domain_file");
    const diagnostics = file.diagnostics ?? [];
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.code === "INVALID_DOMAIN_FILE")).toBe(true);
    expect(file.detail).toBe(diagnostics.map((d) => d.detail).join("\n"));
  });

  test("locateEntry refuses an unknown id after a successful read", async () => {
    const fx = TestPlatform.at(tmp);
    await fx.domain("BILLING");
    const located = await locateEntry(tmp, "BILLING-042");
    expect(located.ok).toBe(false);
    if (located.ok) throw new Error("expected a refusal");
    expect(located.reason).toBe("not_found");
    expect(located.detail).toBe("no entry BILLING-042 in spec-engine/BILLING/SPEC.json");
  });

  // @spec REQ-048 unit
  test("locateEntry finds an id whose prefix names no domain by scanning every domain file", async () => {
    const fx = TestPlatform.at(tmp);
    await fx.domain("BILLING");
    const auth = await fx.domain("AUTH");
    await auth.req({ statement: "The auth service shall expire idle sessions." });
    await plantEdit(tmp, "AUTH", (doc) => {
      entryOf(doc, "AUTH-001").id = "AUTHUI-01";
    });
    const located = await locateEntry(tmp, "AUTHUI-01");
    expect(located.ok).toBe(true);
    if (!located.ok) throw new Error(located.detail);
    expect(located.key).toBe("AUTH");
    expect(located.req.id).toBe("AUTHUI-01");
  });
});
