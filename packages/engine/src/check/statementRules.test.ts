import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { withIndex } from "../operations/_index";
import { check } from "../operations/check";
import { type DomainHandle, TestPlatform } from "../testing/platform";
import { readCheckConfig } from "./severity";
import { statementRuleRows, statementRulesDiagnostics } from "./statementRules";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const BAD = "The endpoint previously answered 404";

let fx: TestPlatform;
let billing: DomainHandle;

beforeEach(async () => {
  fx = TestPlatform.temp("spec-statement-rules-check-");
  fx.checkConfig({
    severity: [],
    statementRules: { severity: { "one-sentence": "warning", "no-history": "warning" } },
  });
  billing = await fx.domain("BILLING");
});

afterEach(() => fx.remove());

// @spec CHCK-049 unit
describe("STATEMENT_RULES", () => {
  test("an Active statement gets one error row per rule it breaks", async () => {
    const { id } = await billing.req({ statement: BAD });
    const rows = await statementRulesDiagnostics(fx.dir, undefined);
    expect(rows).toEqual([
      {
        code: "STATEMENT_RULES",
        severity: "error",
        repo: null,
        source_file: "spec-engine/BILLING/SPEC.json",
        line: expect.any(Number),
        req_id: id,
        detail:
          "one-sentence: 0 sentence terminators; exactly one, at the end — a statement is one testable sentence",
      },
      {
        code: "STATEMENT_RULES",
        severity: "error",
        repo: null,
        source_file: "spec-engine/BILLING/SPEC.json",
        line: expect.any(Number),
        req_id: id,
        detail: 'no-history: "previously" — a statement says what holds now, not how it got there',
      },
    ]);
    expect(rows[0]?.line).toBeGreaterThan(0);
  });

  test("Draft, superseded, and deprecated statements are not reported", async () => {
    await billing.req({ statement: BAD, status: "draft" });
    const old = await billing.req({ statement: BAD });
    await billing.supersede(old.id, { statement: "The endpoint answers 404." });
    const gone = await billing.req({ statement: BAD });
    await billing.deprecate(gone.id);
    expect(await statementRulesDiagnostics(fx.dir, undefined)).toEqual([]);
  });

  // @spec CHRT-022 unit
  test("glossary terms are not reported", async () => {
    await fx.terms();
    await fx.term({ term: "seam", definition: "the seam where two packages meet" });
    expect(await statementRulesDiagnostics(fx.dir, undefined)).toEqual([]);
  });

  // @spec CHCK-048 unit
  test("a per-rule severity grades its rows and leaves the others at error", async () => {
    await billing.req({ statement: BAD });
    const rows = await statementRulesDiagnostics(fx.dir, { severity: { "no-history": "warning" } });
    expect(rows.map((r) => [r.detail.split(":")[0], r.severity])).toEqual([
      ["one-sentence", "error"],
      ["no-history", "warning"],
    ]);
  });

  test("spec check reports the rows, and the code-level severity array regrades them", async () => {
    await billing.req({ statement: BAD });
    fx.checkConfig({ severity: [{ code: "STATEMENT_RULES", severity: "error" }] });
    const result = await withIndex({ platformDir: fx.dir, build: "reset" }, (h) =>
      check({ platformDir: fx.dir }, h.storage),
    );
    if (!result.ok) throw new Error(result.detail);
    const rows = result.diagnostics.filter((d) => d.code === "STATEMENT_RULES");
    expect(rows.map((r) => r.severity)).toEqual(["error", "error"]);
    expect(result.failing).toBe(true);
  });
});

test("the engine's own book breaks the rules only in the known statements", async () => {
  const config = readCheckConfig(REPO_ROOT);
  if (!config.ok) throw new Error(config.detail);
  const rows = await statementRuleRows(REPO_ROOT, config.config.statementRules, {
    statuses: new Set(["active"]),
  });
  expect([...new Set(rows.map((r) => r.req_id))].sort()).toEqual([
    "AUTHOR-007",
    "AUTHOR-009",
    "AUTHOR-012",
    "AUTHOR-013",
    "CHCK-031",
    "CHCK-032",
    "CHCK-040",
    "CHCK-050",
    "CHCK-052",
    "CHCK-053",
    "CHRT-007",
    "CHRT-013",
    "CHRT-023",
    "CHRT-024",
    "DIST-006",
    "DIST-007",
    "DIST-010",
    "DIST-012",
    "DIST-014",
    "DIST-015",
    "DIST-017",
    "DIST-019",
    "DOMAIN-011",
    "DOMAIN-012",
    "DOMAIN-019",
    "DOMAIN-023",
    "GATE-008",
    "GUARD-013",
    "INDX-008",
    "INDX-010",
    "INDX-011",
    "INDX-012",
    "INDX-013",
    "INDX-015",
    "INDX-017",
    "INIT-016",
    "INIT-028",
    "INIT-033",
    "INIT-034",
    "INIT-035",
    "INIT-037",
    "INIT-041",
    "INIT-048",
    "OWNER-002",
    "PROOF-009",
    "PROOF-012",
    "PROP-005",
    "PROV-003",
    "QURY-009",
    "REQ-034",
    "REQ-048",
    "REQ-050",
    "REQ-051",
    "SCHM-024",
    "SCHM-025",
    "SCHM-027",
    "SCHM-028",
    "SCHM-029",
    "SCHM-030",
    "SCHM-035",
    "SERV-012",
    "SERV-025",
    "SERV-028",
    "SERV-029",
    "SERV-030",
    "SERV-031",
    "TRK-004",
  ]);
});
