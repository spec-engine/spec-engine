// packages/engine/test/junit-reader.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec PROOF-001 unit
//
// Unit coverage for the ONE hand-rolled JUnit reader (`results/junit.ts`).
// Feeds checked-in fixture XML (readFileSync of fixtures/junit/*.xml) plus a
// few inline adversarial strings and asserts the returned TestCaseResult[].
// Covers the eight plan behaviors: nested-suite recursion, failure/error/skip
// status mapping, predefined-entity decode, absolute/relative file passthrough,
// jest-flat attribute precedence, XXE immunity, and malformed-input throw.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JUnitParseError, parseJUnit, type TestCaseResult } from "../src/results/junit";

const JUNIT_FIXTURES = join(import.meta.dir, "fixtures", "junit");
const readFixture = (name: string): string => readFileSync(join(JUNIT_FIXTURES, name), "utf8");

const byName = (rows: readonly TestCaseResult[], name: string): TestCaseResult => {
  const row = rows.find((r) => r.name === name);
  if (row === undefined) throw new Error(`no testcase named ${name}`);
  return row;
};

// ---------------------------------------------------------------------------
// Test 1 — bun-green.xml: every testcase passes; nested <testsuite> recursion
// resolves each testcase's file from the nearest ancestor carrying `file`.
// ---------------------------------------------------------------------------

describe("parseJUnit — bun-green (nested suites, all passing)", () => {
  const rows = parseJUnit(readFixture("bun-green.xml"));

  test("recurses nested <testsuite> — all three testcases found", () => {
    expect(rows.length).toBe(3);
  });

  test("every testcase has status 'pass'", () => {
    expect(rows.every((r) => r.status === "pass")).toBe(true);
  });

  test("each testcase inherits file from the nearest ancestor suite", () => {
    expect(rows.every((r) => r.file === "packages/api/test/billing.test.ts")).toBe(true);
  });

  test("line is the numeric testcase@line", () => {
    expect(byName(rows, "charges on renewal").line).toBe(2);
    expect(byName(rows, "applies proration").line).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Test 2 + Test 3 — bun-with-failure.xml: <failure>/<error> → fail,
// <skipped> (incl. TODO) → skip, else pass.
// ---------------------------------------------------------------------------

describe("parseJUnit — bun-with-failure (status mapping)", () => {
  const rows = parseJUnit(readFixture("bun-with-failure.xml"));

  test("self-closing <failure> child → status 'fail'", () => {
    expect(byName(rows, "failing case").status).toBe("fail");
  });

  test("<skipped/> child → status 'skip'", () => {
    expect(byName(rows, "skipped case").status).toBe("skip");
  });

  test("<skipped message=\"TODO\"/> child → status 'skip'", () => {
    expect(byName(rows, "todo case").status).toBe("skip");
  });

  test("<error> child → status 'fail' (error maps to fail)", () => {
    expect(byName(rows, "erroring case").status).toBe("fail");
  });

  test("testcase with no failure/error/skipped child → status 'pass'", () => {
    expect(byName(rows, "passing case").status).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// Test 4 — entities: only the 5 predefined XML entities decode.
// ---------------------------------------------------------------------------

describe("parseJUnit — predefined entity decode", () => {
  const rows = parseJUnit(readFixture("bun-green.xml"));

  test("&lt; &gt; &amp; &quot; &apos; decode to < > & \" '", () => {
    // The fixture carries a testcase named `&lt;&gt;&amp;&quot;&apos;`.
    const decoded = `<>&"'`;
    expect(rows.some((r) => r.name === decoded)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — absolute vs relative file passthrough (reader does NOT normalize).
// ---------------------------------------------------------------------------

describe("parseJUnit — file passthrough (no normalization in the reader)", () => {
  test("absolute testcase@file returned verbatim", () => {
    const abs = "/Users/dev/repo/packages/api/test/pay.test.ts";
    const xml = `<testsuites><testsuite name="s" file="${abs}"><testcase name="c" file="${abs}" line="3" /></testsuite></testsuites>`;
    const rows = parseJUnit(xml);
    expect(rows[0]?.file).toBe(abs);
  });

  test("relative testcase@file returned verbatim", () => {
    const rel = "packages/api/test/pay.test.ts";
    const xml = `<testsuites><testsuite name="s" file="${rel}"><testcase name="c" file="${rel}" line="3" /></testsuite></testsuites>`;
    const rows = parseJUnit(xml);
    expect(rows[0]?.file).toBe(rel);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — jest-sample.xml: flat suite, testcases have NO file/line attr —
// inherit file from <testsuite file=...> or path-like <testsuite name=...>;
// line is null when absent.
// ---------------------------------------------------------------------------

describe("parseJUnit — jest-flat attribute precedence", () => {
  const rows = parseJUnit(readFixture("jest-sample.xml"));

  test("all three flat testcases found", () => {
    expect(rows.length).toBe(3);
  });

  test("testcase inherits file from ancestor <testsuite file=...>", () => {
    expect(byName(rows, "renders total").file).toBe("packages/web/src/checkout.test.js");
    expect(byName(rows, "applies coupon").file).toBe("packages/web/src/checkout.test.js");
  });

  test("testcase inherits path-like <testsuite name=...> when suite has no file attr", () => {
    expect(byName(rows, "adds line item").file).toBe("packages/web/src/cart.test.js");
  });

  test("line is null when no testcase@line attr is present", () => {
    expect(rows.every((r) => r.line === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 6b — WR-03: an explicit empty file="" must fall through to the
// suite/classname fallbacks instead of short-circuiting to "".
// ---------------------------------------------------------------------------

describe('parseJUnit — empty file="" falls through (WR-03)', () => {
  test('testcase with file="" resolves to classname, not ""', () => {
    const xml =
      '<testsuites><testsuite name="s">' +
      '<testcase name="c" file="" classname="pkg/Foo.test.ts" line="3" />' +
      "</testsuite></testsuites>";
    const rows = parseJUnit(xml);
    expect(rows.length).toBe(1);
    expect(rows[0]?.file).toBe("pkg/Foo.test.ts");
  });

  test('testcase with file="" inherits an ancestor testsuite@file', () => {
    const xml =
      '<testsuites><testsuite name="s" file="packages/api/test/pay.test.ts">' +
      '<testcase name="c" file="" line="3" />' +
      "</testsuite></testsuites>";
    const rows = parseJUnit(xml);
    expect(rows[0]?.file).toBe("packages/api/test/pay.test.ts");
  });
});

// ---------------------------------------------------------------------------
// Test 7 — XXE immunity: a DOCTYPE/ENTITY prolog referencing an external
// SYSTEM entity is NOT expanded; the reader never reads the filesystem.
// ---------------------------------------------------------------------------

describe("parseJUnit — XXE immunity", () => {
  const xxe = [
    '<?xml version="1.0"?>',
    '<!DOCTYPE testsuites [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>',
    "<testsuites>",
    '  <testsuite name="s" file="a/b.test.ts">',
    '    <testcase name="&xxe;" file="a/b.test.ts" line="1" />',
    "  </testsuite>",
    "</testsuites>",
  ].join("\n");

  test("external SYSTEM entity is left inert — not expanded to file contents", () => {
    const rows = parseJUnit(xxe);
    expect(rows.length).toBe(1);
    // The DOCTYPE/ENTITY is ignored; `&xxe;` is not one of the 5 predefined
    // entities so it is left undecoded (inert token), never file contents.
    expect(rows[0]?.name).toBe("&xxe;");
    expect(rows[0]?.name.includes("root:")).toBe(false);
    expect(rows[0]?.name.includes("/etc/passwd")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 8b — WR-01: CDATA in a <failure> body whose content contains `]]` and a
// later `>` must parse via the literal `]]>` terminator (not bracket-depth),
// yielding the correct fail status without crashing.
// ---------------------------------------------------------------------------

describe("parseJUnit — CDATA failure body with ']]' and '>' (WR-01)", () => {
  test("CDATA content 'a]] b > c' parses to a single 'fail' testcase, no crash", () => {
    // The `]]` after `a` followed later by `>` is exactly the shape that drove
    // the old skipDeclaration bracket-depth to 0 before the real `]]>`
    // terminator, leaving `c]]>` to be re-parsed as markup → JUnitParseError on
    // a perfectly valid JUnit file.
    const xml = [
      "<testsuites>",
      '  <testsuite name="s" file="a/b.test.ts">',
      '    <testcase name="c" file="a/b.test.ts" line="1">',
      '      <failure message="boom"><![CDATA[assert failed: a]] b > c]]></failure>',
      "    </testcase>",
      "  </testsuite>",
      "</testsuites>",
    ].join("\n");
    const rows = parseJUnit(xml);
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("fail");
    expect(rows[0]?.file).toBe("a/b.test.ts");
  });

  test("CDATA containing an array-diff 'arr[0] > n]]' does not corrupt the testcase set", () => {
    const xml =
      '<testsuites><testsuite name="s" file="x/y.test.ts">' +
      '<testcase name="pass one" file="x/y.test.ts" />' +
      '<testcase name="fail one" file="x/y.test.ts">' +
      "<failure><![CDATA[expected arr[0] > n but arr]] was empty]]></failure>" +
      "</testcase></testsuite></testsuites>";
    const rows = parseJUnit(xml);
    expect(rows.length).toBe(2);
    expect(byName(rows, "pass one").status).toBe("pass");
    expect(byName(rows, "fail one").status).toBe("fail");
  });

  test("unterminated CDATA throws a typed JUnitParseError", () => {
    const bad = '<testsuites><testcase name="x"><failure><![CDATA[no terminator here';
    expect(() => parseJUnit(bad)).toThrow(JUnitParseError);
  });
});

// ---------------------------------------------------------------------------
// Test 8 — malformed/unbalanced XML throws a typed JUnitParseError.
// ---------------------------------------------------------------------------

describe("parseJUnit — malformed input", () => {
  test("unbalanced tags throw", () => {
    const bad = '<testsuites><testcase name="x"></testsuites>';
    expect(() => parseJUnit(bad)).toThrow();
  });

  test("truncated tag throws a typed JUnitParseError", () => {
    const truncated = '<testsuites><testcase name="x"';
    expect(() => parseJUnit(truncated)).toThrow(JUnitParseError);
  });
});
