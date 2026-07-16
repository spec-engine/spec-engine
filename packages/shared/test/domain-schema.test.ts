// packages/shared/test/domain-schema.test.ts
//
// Phase 17 Plan 01 Task 1 — the STRUCTURAL tier of the ONE zod schema.
//
// `validateDomainFile` is the single structural-validation source (STOR-03):
//   - it REJECTS structurally-invalid domain objects with a typed
//     INVALID_DOMAIN_FILE (error-severity) Diagnostic — never a silent pass
//     / silent-zero-requirements (the em-dash trap this phase kills);
//   - it ACCEPTS objects carrying planted SEMANTIC defects (a status outside
//     the status enum, an issue role outside the allow-list) at the structural
//     tier so those rows still land and get diagnosed downstream as
//     BAD_STATUS / UNKNOWN_ROLE (Invariant #4 — the planted mess must survive).

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAndWrite, validateDomainFile } from "../src/domain";

const SRC = "spec-engine/BILLING/SPEC.json";

// A minimal structurally-valid BILLING-shaped domain used as the base for the
// accept cases and as a template the reject cases perturb.
function validDomain() {
  return {
    key: "BILLING",
    owner: "billing-team",
    specVersion: 2,
    updated: "2026-07-01",
    requirements: [
      {
        id: "BILLING-001",
        status: "Superseded",
        statement: "The old renewal charge behavior.",
        why: "Historical.",
        supersededBy: "BILLING-009",
        relates: [],
        livesIn: [],
        issues: [],
      },
      {
        id: "BILLING-009",
        status: "Active",
        statement: "Renewal charge fires on the pinned billing cycle.",
        why: "Revenue correctness.",
        supersedes: "BILLING-001",
        relates: ["BILLING-002"],
        livesIn: ["api/src/billing/renew.ts"],
        issues: [{ role: "supersedes-via", id: "JIRA-4412" }],
        changedAtVersion: 2,
      },
    ],
  };
}

describe("validateDomainFile — structural REJECT (INVALID_DOMAIN_FILE, error severity)", () => {
  function expectReject(input: unknown) {
    const res = validateDomainFile(input, SRC);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected reject");
    expect(res.diagnostics.length).toBeGreaterThanOrEqual(1);
    for (const d of res.diagnostics) {
      expect(d.code).toBe("INVALID_DOMAIN_FILE");
      expect(d.severity).toBe("error");
      expect(d.source_file).toBe(SRC);
    }
    return res.diagnostics;
  }

  test("non-object input (string) rejects with one error diagnostic", () => {
    const diags = expectReject("not a domain object");
    expect(diags.length).toBe(1);
  });

  test("null input rejects", () => {
    expectReject(null);
  });

  test("requirements not an array rejects", () => {
    const d = validDomain() as Record<string, unknown>;
    d.requirements = "nope";
    expectReject(d);
  });

  test("requirement missing id rejects", () => {
    const d = validDomain();
    delete (d.requirements[0] as Record<string, unknown>).id;
    expectReject(d);
  });

  test("requirement id failing ID_RE rejects (bill-1)", () => {
    const d = validDomain();
    d.requirements[0].id = "bill-1";
    expectReject(d);
  });

  test("requirement id failing ID_RE rejects (BILLING, no seq)", () => {
    const d = validDomain();
    d.requirements[0].id = "BILLING";
    expectReject(d);
  });

  test("requirement id empty string rejects", () => {
    const d = validDomain();
    d.requirements[0].id = "";
    expectReject(d);
  });

  test("requirement missing statement rejects", () => {
    const d = validDomain();
    delete (d.requirements[0] as Record<string, unknown>).statement;
    expectReject(d);
  });

  test("requirement empty statement rejects", () => {
    const d = validDomain();
    d.requirements[0].statement = "";
    expectReject(d);
  });

  test("envelope missing key rejects", () => {
    const d = validDomain() as Record<string, unknown>;
    delete d.key;
    expectReject(d);
  });

  test("envelope key failing KEY_RE rejects (dashed key — the silent trap)", () => {
    const d = validDomain();
    d.key = "user-auth";
    expectReject(d);
  });

  test("unknown injected top-level key rejects (.strict — T-17-01)", () => {
    const d = validDomain() as Record<string, unknown>;
    d.__proto__polluter = { admin: true };
    // Also exercise a plain unrecognized key.
    d.bogusTopLevel = 1;
    // CHRT-003 (Phase 1) adds an OPTIONAL `scope` key to the envelope. This
    // reject MUST stay green after that lands — `.strict()` keys on the
    // unrecognized NAME, so whitelisting `scope` does not open the door to
    // `__proto__polluter`/`bogusTopLevel`. If this ever goes red post-scope,
    // the schema was loosened past a single named field (T-01-01 regression).
    expectReject(d);
  });

  test("unknown injected requirement key rejects (.strict)", () => {
    const d = validDomain();
    (d.requirements[0] as Record<string, unknown>).constructorHack = 1;
    expectReject(d);
  });

  test("req_id is attributed on a requirement-scoped failure", () => {
    const d = validDomain();
    d.requirements[1].statement = ""; // BILLING-009 fails
    const res = validateDomainFile(d, SRC);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected reject");
    // At least one diagnostic points at the offending requirement id.
    expect(res.diagnostics.some((x) => x.req_id === "BILLING-009")).toBe(true);
  });
});

describe("validateDomainFile — structural ACCEPT despite SEMANTIC defect (Invariant #4)", () => {
  test("status outside the enum passes the structural tier (ok:true) — lands for BAD_STATUS downstream", () => {
    const d = validDomain();
    d.requirements[0].status = "Bogus";
    const res = validateDomainFile(d, SRC);
    expect(res.ok).toBe(true);
  });

  test("issue role outside the allow-list passes structurally (ok:true) — lands for UNKNOWN_ROLE downstream", () => {
    const d = validDomain();
    d.requirements[1].issues = [{ role: "bogus-role", id: "JIRA-1" }];
    const res = validateDomainFile(d, SRC);
    expect(res.ok).toBe(true);
  });

  test("issue id is OPAQUE — a KEY-NNN-shaped issue id is accepted verbatim", () => {
    const d = validDomain();
    d.requirements[1].issues = [{ role: "created", id: "BILLING-001" }];
    const res = validateDomainFile(d, SRC);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected accept");
    expect(res.data.requirements[1].issues[0]!.id).toBe("BILLING-001");
  });

  test("a full valid BILLING-shaped domain (superseded chain, relates, livesIn, issues) accepts", () => {
    const res = validateDomainFile(validDomain(), SRC);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected accept");
    expect(res.data.key).toBe("BILLING");
    expect(res.data.requirements.length).toBe(2);
    // defaults applied on the terse first requirement's arrays
    expect(res.data.requirements[0]!.relates).toEqual([]);
    expect(res.data.requirements[0]!.livesIn).toEqual([]);
    expect(res.data.requirements[0]!.issues).toEqual([]);
  });

  test("optional array fields default to [] when omitted", () => {
    const d = {
      key: "AUTH",
      specVersion: 1,
      updated: "2026-07-01",
      requirements: [{ id: "AUTH-001", status: "Active", statement: "Login works." }],
    };
    const res = validateDomainFile(d, SRC);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected accept");
    const r = res.data.requirements[0]!;
    expect(r.relates).toEqual([]);
    expect(r.livesIn).toEqual([]);
    expect(r.issues).toEqual([]);
  });
});

// Phase 1 (Domain Charters) — Wave 0 RED contract for the `scope` charter field.
//
// `scope` is the per-domain charter sentence that travels ON the envelope. Two
// invariants are pinned here in executable form BEFORE the schema change lands:
//   1. A domain authored WITH a string scope survives the ONE write seam
//      (`validateAndWrite → orderDomain`) and re-reads with scope intact — i.e.
//      the whitelist rebuild in orderDomain must be taught to carry it, or the
//      field is silently stripped (the em-dash-silent-zero failure mode).
//   2. A domain authored WITHOUT scope stays valid and normalizes to
//      `scope === null` on the round-trip (graceful optional default).
//
// Both cases are RED at this wave: the schema is still `.strict()` WITHOUT
// `scope`, so `validateAndWrite` REJECTS the scoped envelope (ok:false — the
// write never happens) and `orderDomain` DROPS scope from the unscoped one. The
// assertions target the GREEN (plan 01-02) expectation and fail as clean
// assertion failures now — never a thrown exception. Do not soften them.
// @spec CHRT-003 unit
describe("scope round-trip (CHRT-003)", () => {
  // Unique temp path per case. `validateAndWrite → Bun.write` creates the parent
  // dir, and `Bun.file(...).exists()` guards the re-read — so this shared-package
  // test stays node:fs-free (D-10 / WORK-02 runtime-free fence), using only Bun
  // globals plus node:os/node:path for the path.
  let n = 0;
  function writePath() {
    return join(tmpdir(), `chrt-scope-${process.pid}-${Date.now()}-${n++}`, "SPEC.json");
  }

  test("a string scope survives validateAndWrite → re-read (not stripped by orderDomain)", async () => {
    const path = writePath();
    const authored = { ...validDomain(), scope: "some charter sentence" };
    // RED now: `.strict()` (sans scope) makes validateAndWrite reject with
    // ok:false — a clean assertion failure on the line below, not a throw.
    const wrote = await validateAndWrite(path, authored, SRC);
    expect(wrote.ok).toBe(true);

    // Re-read through the same structural seam and assert the charter is intact.
    // Guarded so a not-written file (RED path) can't throw before the scope
    // assertion; GREEN path (plan 01-02) exercises the full round-trip.
    const raw = (await Bun.file(path).exists()) ? await Bun.file(path).text() : "{}";
    const reread = validateDomainFile(JSON.parse(raw), SRC);
    expect(reread.ok).toBe(true);
    if (!reread.ok) throw new Error("expected accept on re-read");
    expect((reread.data as { scope?: unknown }).scope).toBe("some charter sentence");
  });

  test("a domain authored WITHOUT scope re-reads as scope === null (graceful default)", async () => {
    const path = writePath();
    // No scope key — accepted by the current schema, so this write succeeds
    // today; the RED bar is the null-default assertion below (orderDomain drops
    // scope, so re-read yields `undefined`, not `null`, until 01-02).
    const wrote = await validateAndWrite(path, validDomain(), SRC);
    expect(wrote.ok).toBe(true);

    const raw = (await Bun.file(path).exists()) ? await Bun.file(path).text() : "{}";
    const reread = validateDomainFile(JSON.parse(raw), SRC);
    expect(reread.ok).toBe(true);
    if (!reread.ok) throw new Error("expected accept on re-read");
    expect((reread.data as { scope?: unknown }).scope).toBe(null);
  });
});

// Phase 6 Plan 01 — Wave 0 RED contract for the TERM schema fields.
//
// A term is a requirement row (FORK 1 = reuse, not a parallel schema). It
// carries four NEW OPTIONAL fields on SpecRequirementSchema: `term` (the
// glossary headword), `aliases` (synonyms), `cites` (pinned term references)
// and `section` (glossary layout, Wave F). They must survive the ONE write
// seam (validateAndWrite → orderDomain) and re-read byte-identical — or the
// whitelist rebuild in orderDomain silently strips them (the scope/IN-01
// strip-trap this repo has been bitten by twice). This is RED now because
// SpecRequirementSchema is still `.strict()` WITHOUT these fields, so
// validateAndWrite REJECTS the term-bearing envelope (ok:false — the write
// never happens). It goes GREEN when Plan 06-01 Task 2 adds the four fields to
// BOTH the schema and orderDomain. Do not soften these assertions.
// @spec SCHM-005 unit
describe("term field round-trip (TERM-01, dogfooded as SCHM)", () => {
  let n = 0;
  function writePath() {
    return join(tmpdir(), `term-fields-${process.pid}-${Date.now()}-${n++}`, "SPEC.json");
  }

  // A minimal TERM-domain envelope whose lone requirement carries all four
  // new fields. `cites` is an array of the strict `{ term, pinned }` object.
  function termDomain() {
    return {
      key: "TERM",
      owner: null,
      specVersion: 1,
      updated: "2026-07-08",
      requirements: [
        {
          id: "TERM-001",
          status: "Active",
          statement: "Domain — a bounded area of the spec taxonomy.",
          term: "Domain",
          aliases: ["namespace"],
          cites: [{ term: "TERM-003", pinned: 2 }],
          section: "Core nouns",
        },
      ],
    };
  }

  test("term/aliases/cites/section survive validateAndWrite → re-read (not stripped by orderDomain)", async () => {
    const path = writePath();
    // RED now: `.strict()` (sans the four fields) makes validateAndWrite reject
    // with ok:false — a clean assertion failure on the line below, not a throw.
    const wrote = await validateAndWrite(path, termDomain(), SRC);
    expect(wrote.ok).toBe(true);

    const raw = (await Bun.file(path).exists()) ? await Bun.file(path).text() : "{}";
    const reread = validateDomainFile(JSON.parse(raw), SRC);
    expect(reread.ok).toBe(true);
    if (!reread.ok) throw new Error("expected accept on re-read");
    const r = reread.data.requirements[0]! as Record<string, unknown>;
    expect(r.term).toBe("Domain");
    expect(r.aliases).toEqual(["namespace"]);
    expect(r.cites).toEqual([{ term: "TERM-003", pinned: 2 }]);
    expect(r.section).toBe("Core nouns");
  });

  test("a requirement authored WITHOUT the term fields stays valid (all four optional)", async () => {
    const path = writePath();
    const wrote = await validateAndWrite(path, validDomain(), SRC);
    expect(wrote.ok).toBe(true);
    const raw = (await Bun.file(path).exists()) ? await Bun.file(path).text() : "{}";
    const reread = validateDomainFile(JSON.parse(raw), SRC);
    expect(reread.ok).toBe(true);
    if (!reread.ok) throw new Error("expected accept on re-read");
    // aliases / cites default to [] (mirroring relates / livesIn); term /
    // section are plain optionals with no forced default.
    const r = reread.data.requirements[0]! as Record<string, unknown>;
    expect(r.aliases).toEqual([]);
    expect(r.cites).toEqual([]);
  });
});
