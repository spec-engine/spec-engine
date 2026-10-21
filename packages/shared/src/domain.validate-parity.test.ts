import { beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAndWrite, validateDomainFile } from "./domain";

// The shared package's import fence forbids node:fs and bun imports even in
// tests, so these use the `Bun.write` / `Bun.file` globals and a unique path
// per test (no mkdir, no cleanup).

const SRC = "spec-engine/BILLING/SPEC.json";

let tmp: string;
beforeEach(() => {
  tmp = join(tmpdir(), `spec-json-parity-${crypto.randomUUID()}`);
});

// Structurally invalid: the requirement has no `id`.
function invalidDomain() {
  return {
    key: "BILLING",
    specVersion: 1,
    updated: "2026-07-01",
    requirements: [{ status: "Active", statement: "no id here" }],
  };
}

// Keys out of canonical order, so the serializer must impose its own.
function validScrambledDomain() {
  return {
    requirements: [
      {
        issues: [{ id: "JIRA-1", role: "created" }],
        statement: "Renewal charge fires on the pinned billing cycle.",
        id: "BILLING-009",
        relates: ["BILLING-002"],
        status: "Active",
        livesIn: ["api/src/billing/renew.ts"],
        why: "Revenue correctness.",
      },
    ],
    updated: "2026-07-01",
    key: "BILLING",
    specVersion: 2,
    owner: "billing-team",
  };
}

describe("validateAndWrite — read-path == write-path diagnostic identity", () => {
  test("write-path rejection Diagnostic[] deep-equals the index-path Diagnostic[]", async () => {
    const obj = invalidDomain();

    const indexPath = validateDomainFile(obj, SRC);
    expect(indexPath.ok).toBe(false);
    if (indexPath.ok) throw new Error("expected reject");

    const target = join(tmp, "SPEC.json");
    const writePath = await validateAndWrite(target, obj, SRC);
    expect(writePath.ok).toBe(false);
    if (writePath.ok) throw new Error("expected reject");

    expect(writePath.diagnostics).toEqual(indexPath.diagnostics);
  });

  test("a failing validateAndWrite writes NOTHING", async () => {
    const target = join(tmp, "SPEC.json");
    const res = await validateAndWrite(target, invalidDomain(), SRC);
    expect(res.ok).toBe(false);
    expect(await Bun.file(target).exists()).toBe(false);
  });
});

describe("validateAndWrite — deterministic serialization + round-trip", () => {
  test("round-trips a valid object: read-back JSON.parse deep-equals normalized data", async () => {
    const target = join(tmp, "SPEC.json");
    const res = await validateAndWrite(target, validScrambledDomain(), SRC);
    expect(res.ok).toBe(true);

    const readBack = JSON.parse(await Bun.file(target).text());
    expect(readBack).toEqual({
      key: "BILLING",
      owner: "billing-team",
      specVersion: 2,
      updated: "2026-07-01",
      // An unscoped envelope re-reads as an explicit null.
      scope: null,
      requirements: [
        {
          id: "BILLING-009",
          status: "Active",
          statement: "Renewal charge fires on the pinned billing cycle.",
          why: "Revenue correctness.",
          supersedes: null,
          supersededBy: null,
          relates: ["BILLING-002"],
          livesIn: ["api/src/billing/renew.ts"],
          issues: [{ role: "created", id: "JIRA-1" }],
          // aliases/cites default to []; term/section are omitted when absent.
          aliases: [],
          cites: [],
        },
      ],
    });
  });

  test("two successive writes are byte-identical (fixed key order + one trailing newline)", async () => {
    const a = join(tmp, "a.json");
    const b = join(tmp, "b.json");
    await validateAndWrite(a, validScrambledDomain(), SRC);
    await validateAndWrite(b, validScrambledDomain(), SRC);

    const textA = await Bun.file(a).text();
    const textB = await Bun.file(b).text();
    expect(textA).toBe(textB);
    expect(textA.endsWith("}\n")).toBe(true);
    expect(textA.endsWith("}\n\n")).toBe(false);
  });

  test("serialized envelope key order is fixed regardless of input insertion order", async () => {
    const target = join(tmp, "SPEC.json");
    await validateAndWrite(target, validScrambledDomain(), SRC);
    const text = await Bun.file(target).text();
    const keyOrder = ["key", "owner", "specVersion", "updated", "requirements"].map((k) =>
      text.indexOf(`"${k}"`),
    );
    const sorted = [...keyOrder].sort((x, y) => x - y);
    expect(keyOrder).toEqual(sorted);
    const reqOrder = [
      "id",
      "status",
      "statement",
      "why",
      "supersedes",
      "supersededBy",
      "relates",
      "livesIn",
      "issues",
    ].map((k) => text.indexOf(`"${k}"`));
    const reqSorted = [...reqOrder].sort((x, y) => x - y);
    expect(reqOrder).toEqual(reqSorted);
  });
});
