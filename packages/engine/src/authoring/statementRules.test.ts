import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RULE_ZERO } from "@spec-engine/shared";
import { EXIT_FOR_REASON } from "../operations/_result";
import { accept } from "../operations/accept";
import { amend } from "../operations/amend";
import { mint } from "../operations/mint";
import { move } from "../operations/move";
import { supersede } from "../operations/supersede";
import { type DomainHandle, TestPlatform } from "../testing/platform";
import { statementRulesRefusal } from "./statementRules";

const BAD = "The endpoint previously answered 404";
const GOOD = "The endpoint answers 404 for an unknown id.";

let fx: TestPlatform;
let billing: DomainHandle;
let activeId: string;

beforeEach(async () => {
  fx = TestPlatform.temp("spec-statement-rules-");
  billing = await fx.domain("BILLING");
  await fx.domain("LEDGER");
  activeId = (await billing.req({ statement: GOOD })).id;
});

afterEach(() => fx.remove());

function expectRefusal(result: { ok: boolean; reason?: string; detail?: string }): void {
  expect(result.ok).toBe(false);
  if (result.ok || result.reason === undefined || result.detail === undefined) return;
  expect(EXIT_FOR_REASON[result.reason as keyof typeof EXIT_FOR_REASON]).toBe(2);
  const lines = result.detail.split("\n");
  expect(lines).toEqual([
    "one-sentence: 0 sentence terminators; exactly one, at the end — a statement is one testable sentence",
    'no-history: "previously" — a statement says what holds now, not how it got there',
    RULE_ZERO,
  ]);
}

// @spec REQ-060 unit
describe("a statement that breaks a rule is refused before the write", () => {
  test("req", async () => {
    const before = await billing.raw();
    expectRefusal(await mint({ platformDir: fx.dir, key: "BILLING", statement: BAD, why: "" }));
    expect(await billing.raw()).toBe(before);
  });

  test("amend", async () => {
    expectRefusal(await amend({ platformDir: fx.dir, id: activeId, fields: { statement: BAD } }));
  });

  test("supersede", async () => {
    expectRefusal(
      await supersede({ platformDir: fx.dir, id: activeId, statement: BAD }, async () => []),
    );
  });

  test("move with new text", async () => {
    expectRefusal(
      await move(
        { platformDir: fx.dir, id: activeId, targetKey: "LEDGER", statement: BAD },
        async () => [],
      ),
    );
  });

  test("accept judges the draft's statement", async () => {
    fx.statementRulesOff();
    const draft = await billing.req({ statement: BAD, status: "draft" });
    fx.checkConfig({ severity: [] });
    expectRefusal(await accept({ platformDir: fx.dir, id: draft.id }));
  });

  test("a passing statement writes", async () => {
    const minted = await mint({
      platformDir: fx.dir,
      key: "BILLING",
      statement: GOOD,
      why: "",
    });
    expect(minted.ok).toBe(true);
  });
});

// @spec CHRT-022 unit
test("a glossary term is never judged", async () => {
  await fx.terms();
  const term = await fx.term({ term: "seam", definition: "the seam where two packages meet" });
  expect(term.id).toBe("TERM-001");
  expect(statementRulesRefusal(fx.dir, "TERM", BAD)).toBeNull();
});

// @spec CHCK-048 unit
describe("check.json governs the write path", () => {
  test("a rule set to off no longer refuses", () => {
    fx.checkConfig({ severity: [], statementRules: { severity: { "no-history": "off" } } });
    expect(
      statementRulesRefusal(fx.dir, "BILLING", "The endpoint previously answered 404."),
    ).toBeNull();
  });

  test("a warning-severity rule still refuses", () => {
    fx.checkConfig({ severity: [], statementRules: { severity: { "no-history": "warning" } } });
    expect(
      statementRulesRefusal(fx.dir, "BILLING", "The endpoint previously answered 404."),
    ).not.toBeNull();
  });

  test("maxLength, jargon, and exemptNames apply at write time", () => {
    fx.checkConfig({
      severity: [],
      statementRules: { maxLength: 20, jargon: ["widget"], exemptNames: ["SPEC.json"] },
    });
    expect(statementRulesRefusal(fx.dir, "BILLING", "Each SPEC.json holds one seam.")).toBe(
      ["length: 30 characters; at most 20 — a sentence a reader holds at once", RULE_ZERO].join(
        "\n",
      ),
    );
    expect(statementRulesRefusal(fx.dir, "BILLING", "A widget renders.")).toContain("no-jargon");
  });

  test("a check.json that fails the schema refuses with its path", () => {
    fx.file("spec-engine/check.json", '{ "statementRules": { "maxLen": 1 } }');
    expect(statementRulesRefusal(fx.dir, "BILLING", GOOD)).toContain("spec-engine/check.json");
  });
});
