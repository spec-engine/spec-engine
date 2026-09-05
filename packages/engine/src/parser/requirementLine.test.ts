// packages/engine/src/parser/requirementLine.test.ts
//
// The `line` a requirement carries must point at that requirement's own `"id"`
// key. Two ways a naive first-substring scan gets it wrong, both covered here:
// an `issues[]` entry whose opaque tracker id is requirement-id-shaped, and a
// later requirement whose id already appeared earlier in the file.

import { describe, expect, test } from "bun:test";
import { parseDomainJsonFile } from "./domainJson";
import { findRequirementIdLine } from "./requirementLine";

/** A domain where BILLING-002's id appears first inside BILLING-001's issues[]. */
const SHADOWED_BY_ISSUE = {
  key: "BILLING",
  owner: null,
  specVersion: 1,
  updated: "2026-08-16",
  requirements: [
    {
      id: "BILLING-001",
      status: "active",
      statement: "The system shall record a charge.",
      why: "Charges are the ledger.",
      issues: [{ role: "created", id: "BILLING-002" }],
    },
    {
      id: "BILLING-002",
      status: "active",
      statement: "The system shall refund a charge.",
      why: "Refunds close the ledger.",
      issues: [],
    },
  ],
};

function lineOfReq(text: string, id: string): number | undefined {
  const res = parseDomainJsonFile({
    text,
    sourceFile: "spec-engine/BILLING/SPEC.json",
    fallbackKey: "BILLING",
  });
  if (!res.ok) throw new Error(`fixture failed to parse: ${JSON.stringify(res.diagnostics)}`);
  return res.spec.requirements.find((r) => r.id === id)?.line;
}

describe("findRequirementIdLine", () => {
  test("prefers the write seam's six-space indent over a deeper match", () => {
    const lines = [
      "{",
      '  "requirements": [',
      "    {",
      '      "id": "BILLING-001",',
      '      "issues": [',
      "        {",
      '          "role": "created",',
      '          "id": "BILLING-002"',
      "        }",
      "      ]",
      "    },",
      "    {",
      '      "id": "BILLING-002",',
      "    }",
      "  ]",
      "}",
    ];
    // Index 7 is the issue's id at ten spaces; index 12 is the requirement's own.
    expect(findRequirementIdLine(lines, "BILLING-002")).toBe(12);
  });

  test("never returns a line at or before the cursor", () => {
    const lines = ['      "id": "A-001",', "      x", '      "id": "A-001",'];
    expect(findRequirementIdLine(lines, "A-001", 1)).toBe(2);
  });

  test("falls back to a loose match when the file is not seam-serialized", () => {
    const lines = ["{", '"id": "A-001", "status": "active"'];
    expect(findRequirementIdLine(lines, "A-001")).toBe(1);
  });

  test("returns -1 when the id is absent", () => {
    expect(findRequirementIdLine(['      "id": "A-001",'], "A-999")).toBe(-1);
  });
});

describe("requirement line anchoring", () => {
  test("an issue id shaped like a requirement id does not steal the anchor", () => {
    const text = `${JSON.stringify(SHADOWED_BY_ISSUE, null, 2)}\n`;
    const lines = text.split("\n");

    const anchored = lineOfReq(text, "BILLING-002");
    expect(anchored).toBeDefined();
    // The anchored line is the requirement's own key, at the seam indent.
    expect(lines[(anchored as number) - 1]).toBe('      "id": "BILLING-002",');
    // And it is strictly after BILLING-001's, which the naive scan would tie.
    expect(anchored as number).toBeGreaterThan(lineOfReq(text, "BILLING-001") as number);
  });
});
