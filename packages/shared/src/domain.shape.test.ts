// The hand-shaped input is written to a plain path, not a platform's
// SPEC.json: it is seam input, not a platform fixture.

import { beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDomainText, type SpecDomain, validateAndWrite, verifyRoundTrip } from "./domain";

const SRC = "spec-engine/BILLING/SPEC.json";

let target: string;
beforeEach(() => {
  target = join(tmpdir(), `spec-shape-${crypto.randomUUID()}`, "domain.json");
});

const text = (obj: unknown) => `${JSON.stringify(obj, null, 2)}\n`;

/** Trimmed optional fields and a non-canonical key order, as an adopter writes it. */
function handShaped() {
  return {
    key: "BILLING",
    updated: "2026-01-01",
    scope: "billing",
    requirements: [
      {
        id: "BILLING-001",
        statement: "The billing service shall charge on renewal.",
        status: "active",
        issues: [{ role: "created", id: "ENG-1" }],
        relates: ["BILLING-002"],
      },
      {
        id: "BILLING-002",
        statement: "The billing service shall refund on cancel.",
        status: "active",
        why: "trust",
      },
    ],
  };
}

async function writeAndLoad(): Promise<SpecDomain> {
  await Bun.write(target, text(handShaped()));
  const parsed = parseDomainText(await Bun.file(target).text(), SRC);
  if (!parsed.ok) throw new Error("fixture does not parse");
  return parsed.data;
}

const entry = (d: SpecDomain, i: number) => d.requirements[i] as SpecDomain["requirements"][number];

describe("validateAndWrite preserves an existing file's shape", () => {
  // @spec SCHM-031 unit
  // @spec SCHM-033 unit
  test("an appended entry and the updated date are the only change", async () => {
    const domain = await writeAndLoad();
    domain.updated = "2026-02-02";
    domain.requirements.push({
      id: "BILLING-003",
      status: "active",
      statement: "The billing service shall email a receipt.",
      why: null,
      supersedes: null,
      supersededBy: null,
      relates: [],
      issues: [{ role: "created", id: "ENG-7" }],
      aliases: [],
      cites: [],
    });
    expect((await validateAndWrite(target, domain, SRC)).ok).toBe(true);

    const expected = handShaped();
    expected.updated = "2026-02-02";
    const appended = {
      id: "BILLING-003",
      statement: "The billing service shall email a receipt.",
      status: "active",
      why: null,
      issues: [{ role: "created", id: "ENG-7" }],
    };
    (expected.requirements as unknown[]).push(appended);
    expect(await Bun.file(target).text()).toBe(text(expected));
  });

  // @spec SCHM-031 unit
  // @spec SCHM-032 unit
  test("a flipped entry is patched in its key order and the others stay byte-identical", async () => {
    const domain = await writeAndLoad();
    const first = entry(domain, 0);
    first.status = "superseded";
    first.supersededBy = "BILLING-009";
    first.relates = [];
    first.issues = [];
    expect((await validateAndWrite(target, domain, SRC)).ok).toBe(true);

    const expected = {
      ...handShaped(),
      requirements: [
        {
          id: "BILLING-001",
          statement: "The billing service shall charge on renewal.",
          status: "superseded",
          issues: [],
          relates: [],
          supersededBy: "BILLING-009",
        },
        handShaped().requirements[1],
      ],
    };
    expect(await Bun.file(target).text()).toBe(text(expected));
  });

  // @spec SCHM-032 unit
  test("a cleared why on an entry that never carried the key adds no key", async () => {
    const domain = await writeAndLoad();
    entry(domain, 0).why = null;
    entry(domain, 1).why = null;
    expect((await validateAndWrite(target, domain, SRC)).ok).toBe(true);

    const expected = handShaped();
    (expected.requirements[1] as { why: string | null }).why = null;
    expect(await Bun.file(target).text()).toBe(text(expected));
  });

  // @spec SCHM-038 unit
  test("a write drops livesIn and verifiedIn from every entry and changes nothing else", async () => {
    const legacy = handShaped();
    Object.assign(legacy.requirements[0] as object, { livesIn: ["api/renew.ts"] });
    Object.assign(legacy.requirements[1] as object, { verifiedIn: ["api/refund.test.ts"] });
    await Bun.write(target, text(legacy));
    const parsed = parseDomainText(await Bun.file(target).text(), SRC);
    if (!parsed.ok) throw new Error("legacy fields must parse");
    expect((await validateAndWrite(target, parsed.data, SRC)).ok).toBe(true);
    expect(await Bun.file(target).text()).toBe(text(handShaped()));
  });

  // @spec SCHM-031 unit
  test("a rewrite with no change leaves the file byte-identical", async () => {
    const domain = await writeAndLoad();
    expect((await validateAndWrite(target, domain, SRC)).ok).toBe(true);
    expect(await Bun.file(target).text()).toBe(text(handShaped()));
  });

  // @spec SCHM-042 unit
  // @spec SCHM-043 unit
  test("a $schema key after the first position parses and stays in place through a changed write", async () => {
    const { key, ...rest } = handShaped();
    const withSchema = { key, $schema: "./local.json", ...rest };
    await Bun.write(target, text(withSchema));
    const parsed = parseDomainText(await Bun.file(target).text(), SRC);
    if (!parsed.ok) throw new Error("a $schema key must parse");
    parsed.data.updated = "2026-02-02";
    expect((await validateAndWrite(target, parsed.data, SRC)).ok).toBe(true);
    expect(await Bun.file(target).text()).toBe(text({ ...withSchema, updated: "2026-02-02" }));
    expect(parseDomainText(text({ ...withSchema, $schemas: "x" }), SRC).ok).toBe(false);
  });

  // @spec SCHM-044 unit
  test("a $schema key added to a file that lacks one is written first", async () => {
    const domain = await writeAndLoad();
    expect((await validateAndWrite(target, { ...domain, $schema: "u" }, SRC)).ok).toBe(true);
    expect(await Bun.file(target).text()).toBe(text({ $schema: "u", ...handShaped() }));
  });

  // @spec SCHM-034 unit
  test("a rewrite that does not re-parse to the validated domain is refused", async () => {
    const domain = await writeAndLoad();
    const wrong = text(handShaped()).replace("charge on renewal", "charge twice");
    const verdict = verifyRoundTrip(wrong, domain, SRC);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.diagnostics[0]?.code).toBe("INVALID_DOMAIN_FILE");
    expect(verifyRoundTrip(text(handShaped()), domain, SRC).ok).toBe(true);
  });
});
