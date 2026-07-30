// packages/shared/test/ears.test.ts
//
// The EARS statement parser (shared/ears.ts) — the five shapes decompose into
// clauses; everything else is rejected with a plain-words problem plus the
// expected shapes (with a filled example, never just a rule name).
//
// Verifies:
// @spec SCHM-010 unit

import { describe, expect, test } from "bun:test";
import { parseEarsStatement } from "../src/ears";

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
