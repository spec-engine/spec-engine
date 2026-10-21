// @spec SCHM-010 unit

import { describe, expect, test } from "bun:test";
import { parseEarsStatement } from "./ears";

describe("parseEarsStatement — the five shapes decompose", () => {
  test("event: When <trigger>, the <system> shall <result>", () => {
    const r = parseEarsStatement(
      "When an unknown requirement id is passed, spec resolve shall print [] and exit 0.",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.clauses.pattern).toBe("when");
      expect(r.clauses.condition).toBe("an unknown requirement id is passed");
      expect(r.clauses.system).toBe("spec resolve");
      expect(r.clauses.response).toBe("print [] and exit 0.");
    }
  });

  test("state: While <state>, the <system> shall <result>", () => {
    const r = parseEarsStatement(
      "While the index file is missing, the read commands shall rebuild it before answering.",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.clauses.pattern).toBe("while");
      expect(r.clauses.system).toBe("read commands");
    }
  });

  test("unwanted: If <failure>, then the <system> shall <result>", () => {
    const r = parseEarsStatement(
      "If the results file cannot be parsed, then spec check shall report the file and exit 2.",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.clauses.pattern).toBe("if");
  });

  test("feature: Where <feature>, the <system> shall <result>", () => {
    const r = parseEarsStatement(
      "Where a member config lists ignore directories, the scanner shall skip them.",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.clauses.pattern).toBe("where");
  });

  test("always: The <system> shall <result>", () => {
    const r = parseEarsStatement("The spec CLI shall write JSON output to stdout only.");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.clauses.pattern).toBe("always");
      expect(r.clauses.condition).toBeNull();
      expect(r.clauses.system).toBe("spec CLI");
    }
  });
});

describe("parseEarsStatement — rejections say what is missing, in plain words", () => {
  test("no shall: names the missing word and shows an example", () => {
    const r = parseEarsStatement("An order total equals the sum of its line items.");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toContain('"shall"');
      expect(r.expected).toContain("spec resolve shall print [] and exit 0");
    }
  });

  test("When with no comma: says the trigger clause never ends", () => {
    const r = parseEarsStatement("When a refund is issued the system shall reverse the tax.");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("add a comma");
  });

  test("If with no then: names the missing handover", () => {
    const r = parseEarsStatement("If the file is malformed, spec check shall exit 2.");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain('", then"');
  });

  test("empty statement rejects", () => {
    expect(parseEarsStatement("   ").ok).toBe(false);
  });
});

// @spec CHCK-040 unit
// @spec CHCK-041 unit
// @spec CHCK-042 unit
describe("parseEarsStatement — one promise per statement", () => {
  test('"; " after shall rejects with the one-promise hint', () => {
    const r = parseEarsStatement(
      "If the file is missing, then spec check shall exit 2; nothing is written.",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toContain('"; "');
      expect(r.expected).toContain("one promise per statement");
    }
  });

  test("a semicolon in the condition is not a second clause", () => {
    expect(parseEarsStatement("When a; b holds, spec check shall exit 1.").ok).toBe(true);
  });

  test('", and <subject> shall" rejects; ", and shall" with no new subject passes', () => {
    const second = parseEarsStatement("spec check shall exit 1, and the log shall name the file.");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.problem).toContain("own subject");
    expect(parseEarsStatement("spec check shall exit 1, and shall name the file.").ok).toBe(true);
  });

  test("each rationale connective rejects, naming the connective", () => {
    for (const word of ["because", "so that", "in order to"]) {
      const r = parseEarsStatement(`spec check shall exit 1 ${word} CI stops.`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem).toContain(`"${word}"`);
    }
  });

  test('a trailing ", so <consequence>" passes', () => {
    const r = parseEarsStatement(
      "spec check shall report it at warning severity, so a lone warning never fails the gate.",
    );
    expect(r.ok).toBe(true);
  });
});
