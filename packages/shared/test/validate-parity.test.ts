// packages/shared/test/validate-parity.test.ts
//
// Phase 17 Plan 01 Task 2 — `validateAndWrite` (the write seam) and VAL-02.
//
// VAL-02 (the headline): author-time validation == index-time validation because
// it is literally ONE function. For a single structurally-invalid domain object,
// the Diagnostic[] surfaced on the WRITE path (validateAndWrite rejection) must be
// byte-identical to the Diagnostic[] surfaced on the READ/index path
// (validateDomainFile) — proven here by a deep-equality assertion.
//
// Serialization determinism (Pitfall 3): validateAndWrite serializes with a FIXED
// key order + exactly one trailing newline, so two writes of the same object are
// byte-identical regardless of the input object's key insertion order.

import { beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAndWrite, validateDomainFile } from "../src/domain";

// `@spec-engine/shared` is runtime-free (D-10 / WORK-02): its import fence forbids
// node:fs / fs / bun / bun:sqlite even in tests. Mirror src's discipline —
// use the `Bun.write` / `Bun.file` GLOBALS (not imports) plus a unique
// crypto.randomUUID() path per test. `Bun.write` auto-creates parent dirs, so
// no mkdir is needed; each path is unique-per-run, so no rm cleanup is needed.

const SRC = "spec-engine/BILLING/SPEC.json";

let tmp: string;
beforeEach(() => {
  tmp = join(tmpdir(), `spec-json-parity-${crypto.randomUUID()}`);
});

// A structurally-invalid object: BILLING-009 is missing its `id`.
function invalidDomain() {
  return {
    key: "BILLING",
    specVersion: 1,
    updated: "2026-07-01",
    requirements: [{ status: "Active", statement: "no id here" }],
  };
}

// A valid object with keys authored OUT OF the canonical serialization order,
// to prove the serializer imposes a fixed order rather than echoing insertion.
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

describe("validateAndWrite — VAL-02 read-path == write-path diagnostic identity", () => {
  test("write-path rejection Diagnostic[] deep-equals the index-path Diagnostic[]", async () => {
    const obj = invalidDomain();

    const indexPath = validateDomainFile(obj, SRC);
    expect(indexPath.ok).toBe(false);
    if (indexPath.ok) throw new Error("expected reject");

    const target = join(tmp, "SPEC.json");
    const writePath = await validateAndWrite(target, obj, SRC);
    expect(writePath.ok).toBe(false);
    if (writePath.ok) throw new Error("expected reject");

    // The single-validator guarantee: byte-identical diagnostics on both paths.
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
      // orderDomain emits `scope: d.scope ?? null` after `updated` (CHRT-03,
      // plan 01-02): an unscoped envelope re-reads as an explicit null.
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
          // TERM-01 (Phase 6): aliases/cites carry a schema `.default([])`, so
          // orderDomain now always emits them (like relates/livesIn) after
          // issues. term/section are plain optionals — omitted when absent.
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
    // exactly one trailing newline
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
    // requirement item key order
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
