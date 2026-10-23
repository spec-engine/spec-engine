// @spec INDX-016 unit

import { describe, expect, test } from "bun:test";
import { parseDomainJsonFile } from "./domainJson";

/** Callers put `id` first on each requirement so the reader's literal
 *  `"id": "…"` line search is stable. */
function domainJson(requirements: unknown[], envelope: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      key: "BILLING",
      owner: "drea",
      specVersion: 2,
      updated: "2026-06-02",
      requirements,
      ...envelope,
    },
    null,
    2,
  );
}

function parseOk(text: string) {
  const result = parseDomainJsonFile({
    text,
    sourceFile: "spec-engine/BILLING/SPEC.json",
    fallbackKey: "BILLING",
  });
  if (!result.ok) {
    throw new Error(
      `expected ok reader result, got diagnostics: ${JSON.stringify(result.diagnostics)}`,
    );
  }
  return result.spec;
}

describe("parseDomainJsonFile — status case-map", () => {
  test("lowercase active/superseded map to Capitalized RequirementStatus", () => {
    const spec = parseOk(
      domainJson([
        { id: "BILLING-001", status: "superseded", statement: "old", supersededBy: "BILLING-009" },
        { id: "BILLING-009", status: "active", statement: "new" },
      ]),
    );
    const byId = new Map(spec.requirements.map((r) => [r.id, r]));
    expect(byId.get("BILLING-001")?.status).toBe("Superseded");
    expect(byId.get("BILLING-001")?.superseded_by).toBe("BILLING-009");
    expect(byId.get("BILLING-009")?.status).toBe("Active");
  });

  test("an unknown status casts through verbatim so BAD_STATUS can land downstream", () => {
    const spec = parseOk(
      domainJson([{ id: "BILLING-002", status: "bogus", statement: "retry on failure" }]),
    );
    // Compared as a plain string: the row's static type is the RequirementStatus union.
    expect(spec.requirements[0]?.status as string).toBe("bogus");
  });

  test("statement/why/seq map onto the internal row; spec_version is DERIVED, not the authored 2", () => {
    const spec = parseOk(
      domainJson([
        { id: "BILLING-007", status: "active", statement: "compute tax", why: "Compliance." },
      ]),
    );
    const r = spec.requirements[0];
    expect(r?.text).toBe("compute tax");
    expect(r?.why).toBe("Compliance.");
    expect(r?.seq).toBe(7);
    // The `domainJson` helper authors `specVersion: 2`.
    expect(r?.spec_version).toBe(1);
    expect(r?.key).toBe("BILLING");
    expect(r?.source_file).toBe("spec-engine/BILLING/SPEC.json");
  });
});

describe("parseDomainJsonFile — derived domain version", () => {
  // @spec SCHM-018 unit
  test("zero supersessions → version 1 even when the envelope authors a higher number", () => {
    const spec = parseOk(
      domainJson([{ id: "BILLING-001", status: "active", statement: "a" }], { specVersion: 99 }),
    );
    expect(spec.spec_version).toBe(1);
  });

  // @spec SCHM-018 unit
  test("N supersede edges → version N+1 (one monotonic step per supersession)", () => {
    const spec = parseOk(
      domainJson(
        [
          {
            id: "BILLING-001",
            status: "superseded",
            statement: "old a",
            supersededBy: "BILLING-009",
          },
          {
            id: "BILLING-002",
            status: "superseded",
            statement: "old b",
            supersededBy: "BILLING-010",
          },
          { id: "BILLING-009", status: "active", statement: "new a" },
          { id: "BILLING-010", status: "active", statement: "new b" },
        ],
        { specVersion: 1 },
      ),
    );
    expect(spec.spec_version).toBe(3); // 1 + 2 edges
  });

  // @spec SCHM-019 unit
  test("monotonic: adding one more supersession advances the derived version by exactly one", () => {
    const one = parseOk(
      domainJson([
        { id: "BILLING-001", status: "superseded", statement: "old", supersededBy: "BILLING-009" },
        { id: "BILLING-009", status: "active", statement: "new" },
      ]),
    );
    const two = parseOk(
      domainJson([
        { id: "BILLING-001", status: "superseded", statement: "old", supersededBy: "BILLING-009" },
        { id: "BILLING-009", status: "superseded", statement: "new", supersededBy: "BILLING-011" },
        { id: "BILLING-011", status: "active", statement: "newer" },
      ]),
    );
    expect(one.spec_version).toBe(2);
    expect(two.spec_version).toBe(3);
    expect(two.spec_version - one.spec_version).toBe(1);
  });

  // @spec SCHM-018 unit
  test("a cross-domain supersededBy still counts in the source domain (the req died here)", () => {
    const spec = parseOk(
      domainJson([
        {
          id: "BILLING-001",
          status: "superseded",
          statement: "moved out",
          supersededBy: "TAX-004",
        },
        { id: "BILLING-002", status: "active", statement: "stayed" },
      ]),
    );
    expect(spec.spec_version).toBe(2); // 1 + the one cross-domain edge
  });
});

describe("parseDomainJsonFile — deterministic literal-substring line derivation", () => {
  test('the returned line points at the requirement\'s "id" line in the raw text', () => {
    const text = domainJson([
      { id: "BILLING-001", status: "active", statement: "first" },
      { id: "BILLING-009", status: "active", statement: "second" },
    ]);
    const rawLines = text.split("\n");
    const spec = parseOk(text);
    for (const r of spec.requirements) {
      const derivedLine = r.line;
      expect(rawLines[derivedLine - 1]).toContain(`"id": "${r.id}"`);
    }
  });

  test("re-running the reader on the same text yields identical line values", () => {
    const text = domainJson([
      { id: "BILLING-001", status: "active", statement: "first" },
      { id: "BILLING-009", status: "active", statement: "second" },
    ]);
    const a = parseOk(text).requirements.map((r) => [r.id, r.line]);
    const b = parseOk(text).requirements.map((r) => [r.id, r.line]);
    expect(a).toEqual(b);
  });
});

describe("parseDomainJsonFile — relates / issues flattening", () => {
  test("a relates entry becomes a RelationRow; a self-reference surfaces in self_relates (never stored)", () => {
    const spec = parseOk(
      domainJson([
        {
          id: "BILLING-001",
          status: "active",
          statement: "first",
          relates: ["BILLING-009", "BILLING-001"],
        },
      ]),
    );
    expect(spec.relations).toEqual([
      {
        from_id: "BILLING-001",
        to_id: "BILLING-009",
        source_file: "spec-engine/BILLING/SPEC.json",
        line: spec.requirements[0]?.line as number,
      },
    ]);
    expect(spec.self_relates.map((s) => s.req_id)).toEqual(["BILLING-001"]);
  });

  test("issues flatten to ProvenanceRows in authored order; opaque KEY-NNN id stored verbatim", () => {
    const spec = parseOk(
      domainJson([
        {
          id: "BILLING-009",
          status: "active",
          statement: "new",
          issues: [
            { role: "created", id: "ENG-1432" },
            { role: "supersedes-via", id: "ENG-1781" },
            { role: "created", id: "BILLING-001" },
          ],
        },
      ]),
    );
    expect(spec.provenance.map((p) => [p.role, p.issue_id])).toEqual([
      ["created", "ENG-1432"],
      ["supersedes-via", "ENG-1781"],
      ["created", "BILLING-001"],
    ]);
    expect(spec.provenance[2]?.issue_id).toBe("BILLING-001");
  });

  test("a bad issue role lands in unknown_roles (never stored in provenance)", () => {
    const spec = parseOk(
      domainJson([
        {
          id: "BILLING-002",
          status: "active",
          statement: "retry",
          issues: [
            { role: "created", id: "ENG-1" },
            { role: "bogus-role", id: "ENG-9" },
            { role: "supersedes-via", id: "ENG-2" },
          ],
        },
      ]),
    );
    expect(spec.provenance.map((p) => [p.role, p.issue_id])).toEqual([
      ["created", "ENG-1"],
      ["supersedes-via", "ENG-2"],
    ]);
    expect(spec.unknown_roles.map((u) => u.role)).toEqual(["bogus-role"]);
    expect(spec.unknown_roles[0]?.req_id).toBe("BILLING-002");
  });

  test("duplicate (role, issue) pairs dedupe; duplicate relates targets dedupe", () => {
    const spec = parseOk(
      domainJson([
        {
          id: "BILLING-009",
          status: "active",
          statement: "new",
          relates: ["BILLING-007", "BILLING-007"],
          issues: [
            { role: "created", id: "ENG-1432" },
            { role: "created", id: "ENG-1432" },
          ],
        },
      ]),
    );
    expect(spec.relations.map((r) => r.to_id)).toEqual(["BILLING-007"]);
    expect(spec.provenance.map((p) => p.issue_id)).toEqual(["ENG-1432"]);
  });
});

describe("parseDomainJsonFile — structural failure returns diagnostics", () => {
  test("non-JSON text returns an INVALID_DOMAIN_FILE diagnostic, not a throw", () => {
    const result = parseDomainJsonFile({
      text: "{ not json",
      sourceFile: "spec-engine/BILLING/SPEC.json",
      fallbackKey: "BILLING",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.code).toBe("INVALID_DOMAIN_FILE");
      expect(result.diagnostics[0]?.severity).toBe("error");
    }
  });

  test("a requirement missing id returns an INVALID_DOMAIN_FILE diagnostic", () => {
    const result = parseDomainJsonFile({
      text: domainJson([{ status: "active", statement: "no id here" }]),
      sourceFile: "spec-engine/BILLING/SPEC.json",
      fallbackKey: "BILLING",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.every((d) => d.code === "INVALID_DOMAIN_FILE")).toBe(true);
    }
  });
});
