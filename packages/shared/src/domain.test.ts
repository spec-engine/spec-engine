import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAndWrite, validateDomainFile } from "./domain";

const SRC = "spec-engine/BILLING/SPEC.json";

/** The i-th requirement of a test envelope; a missing one is a test bug. */
function entry(d: ReturnType<typeof validDomain>, i: number) {
  const r = d.requirements[i];
  if (r === undefined) throw new Error(`no requirement ${i}`);
  return r;
}

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
        issues: [],
      },
      {
        id: "BILLING-009",
        status: "Active",
        statement: "Renewal charge fires on the pinned billing cycle.",
        why: "Revenue correctness.",
        supersedes: "BILLING-001",
        relates: ["BILLING-002"],
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
    entry(d, 0).id = "bill-1";
    expectReject(d);
  });

  test("requirement id failing ID_RE rejects (BILLING, no seq)", () => {
    const d = validDomain();
    entry(d, 0).id = "BILLING";
    expectReject(d);
  });

  test("requirement id empty string rejects", () => {
    const d = validDomain();
    entry(d, 0).id = "";
    expectReject(d);
  });

  test("requirement missing statement rejects", () => {
    const d = validDomain();
    delete (d.requirements[0] as Record<string, unknown>).statement;
    expectReject(d);
  });

  test("requirement empty statement rejects", () => {
    const d = validDomain();
    entry(d, 0).statement = "";
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

  test("unknown injected top-level key rejects (.strict)", () => {
    const d = validDomain() as Record<string, unknown>;
    d.__proto__polluter = { admin: true };
    d.bogusTopLevel = 1;
    // Whitelisting `scope` must not open the door to any other unknown key.
    expectReject(d);
  });

  test("unknown injected requirement key rejects (.strict)", () => {
    const d = validDomain();
    (d.requirements[0] as Record<string, unknown>).constructorHack = 1;
    expectReject(d);
  });

  test("req_id is attributed on a requirement-scoped failure", () => {
    const d = validDomain();
    entry(d, 1).statement = ""; // BILLING-009 fails
    const res = validateDomainFile(d, SRC);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected reject");
    expect(res.diagnostics.some((x) => x.req_id === "BILLING-009")).toBe(true);
  });
});

describe("validateDomainFile — structural ACCEPT despite a SEMANTIC defect", () => {
  test("status outside the enum passes the structural tier (ok:true) — lands for BAD_STATUS downstream", () => {
    const d = validDomain();
    entry(d, 0).status = "Bogus";
    const res = validateDomainFile(d, SRC);
    expect(res.ok).toBe(true);
  });

  test("issue role outside the allow-list passes structurally (ok:true) — lands for UNKNOWN_ROLE downstream", () => {
    const d = validDomain();
    entry(d, 1).issues = [{ role: "bogus-role", id: "JIRA-1" }];
    const res = validateDomainFile(d, SRC);
    expect(res.ok).toBe(true);
  });

  test("issue id is OPAQUE — a KEY-NNN-shaped issue id is accepted verbatim", () => {
    const d = validDomain();
    entry(d, 1).issues = [{ role: "created", id: "BILLING-001" }];
    const res = validateDomainFile(d, SRC);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected accept");
    expect(res.data.requirements[1]?.issues[0]?.id).toBe("BILLING-001");
  });

  test("a full valid BILLING-shaped domain (superseded chain, relates, issues) accepts", () => {
    const res = validateDomainFile(validDomain(), SRC);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected accept");
    expect(res.data.key).toBe("BILLING");
    expect(res.data.requirements.length).toBe(2);
    expect(res.data.requirements[0]?.relates).toEqual([]);
    expect(res.data.requirements[0]?.issues).toEqual([]);
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
    expect(r.issues).toEqual([]);
  });

  // @spec SCHM-037 unit
  test("an entry carrying livesIn or verifiedIn is accepted and the fields are dropped", () => {
    const d = validDomain();
    const legacy = {
      ...d,
      requirements: [{ ...entry(d, 0), livesIn: ["api/renew.ts"], verifiedIn: "anything" }],
    };
    const res = validateDomainFile(legacy, SRC);
    if (!res.ok) throw new Error("expected accept");
    expect(res.data.requirements[0]).not.toHaveProperty("livesIn");
    expect(res.data.requirements[0]).not.toHaveProperty("verifiedIn");
  });
});

// @spec SCHM-042 unit
describe("scope round-trip", () => {
  // `Bun.file` and `validateAndWrite` only: this shared-package test stays
  // node:fs-free under the runtime-free import fence.
  let n = 0;
  function writePath() {
    return join(tmpdir(), `chrt-scope-${process.pid}-${Date.now()}-${n++}`, "SPEC.json");
  }

  test("a string scope survives validateAndWrite → re-read (not stripped by orderDomain)", async () => {
    const path = writePath();
    const authored = { ...validDomain(), scope: "some charter sentence" };
    const wrote = await validateAndWrite(path, authored, SRC);
    expect(wrote.ok).toBe(true);

    // Guarded so a write that did not happen fails on the assertion, not a throw.
    const raw = (await Bun.file(path).exists()) ? await Bun.file(path).text() : "{}";
    const reread = validateDomainFile(JSON.parse(raw), SRC);
    expect(reread.ok).toBe(true);
    if (!reread.ok) throw new Error("expected accept on re-read");
    expect((reread.data as { scope?: unknown }).scope).toBe("some charter sentence");
  });

  test("a domain authored WITHOUT scope re-reads as scope === null (graceful default)", async () => {
    const path = writePath();
    const wrote = await validateAndWrite(path, validDomain(), SRC);
    expect(wrote.ok).toBe(true);

    const raw = (await Bun.file(path).exists()) ? await Bun.file(path).text() : "{}";
    const reread = validateDomainFile(JSON.parse(raw), SRC);
    expect(reread.ok).toBe(true);
    if (!reread.ok) throw new Error("expected accept on re-read");
    expect((reread.data as { scope?: unknown }).scope).toBe(null);
  });
});

// @spec SCHM-042 unit
describe("term field round-trip", () => {
  let n = 0;
  function writePath() {
    return join(tmpdir(), `term-fields-${process.pid}-${Date.now()}-${n++}`, "SPEC.json");
  }

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
    const r = reread.data.requirements[0]! as Record<string, unknown>;
    expect(r.aliases).toEqual([]);
    expect(r.cites).toEqual([]);
  });
});
