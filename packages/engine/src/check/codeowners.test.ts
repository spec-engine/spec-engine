// @spec OWNER-003 unit
import { describe, expect, test } from "bun:test";
import { matchesGlob, ownersForPath, parseCodeowners } from "./codeowners";

describe("parseCodeowners()", () => {
  test("strips comments, ignores blank lines, splits owners, preserves order", () => {
    const text = [
      "# top comment",
      "",
      "spec-engine/            @team-a @team-b",
      "  ",
      "spec-engine/BILLING/    @drea  # trailing comment",
    ].join("\n");
    const rules = parseCodeowners(text);
    expect(rules).toEqual([
      { pattern: "spec-engine/", owners: ["@team-a", "@team-b"] },
      { pattern: "spec-engine/BILLING/", owners: ["@drea"] },
    ]);
  });

  test("a pattern with no owners parses to an empty owners array", () => {
    expect(parseCodeowners("spec-engine/")).toEqual([{ pattern: "spec-engine/", owners: [] }]);
  });
});

describe("ownersForPath()", () => {
  test("LAST match wins (not most-specific, not first)", () => {
    const rules = [
      { pattern: "spec-engine/", owners: ["@team"] },
      { pattern: "spec-engine/BILLING/", owners: ["@drea"] },
    ];
    expect(ownersForPath(rules, "spec-engine/BILLING/SPEC.json")).toEqual(["@drea"]);
  });

  test("last match wins even when the broader rule is authored last", () => {
    const rules = [
      { pattern: "spec-engine/BILLING/", owners: ["@drea"] },
      { pattern: "spec-engine/", owners: ["@team"] },
    ];
    expect(ownersForPath(rules, "spec-engine/BILLING/SPEC.json")).toEqual(["@team"]);
  });

  test("unmatched path → []", () => {
    const rules = [{ pattern: "spec-engine/BILLING/", owners: ["@drea"] }];
    expect(ownersForPath(rules, "packages/engine/src/index.ts")).toEqual([]);
  });
});

describe("matchesGlob()", () => {
  test("trailing-slash directory pattern matches the whole subtree", () => {
    expect(matchesGlob("spec-engine/BILLING/", "spec-engine/BILLING/SPEC.json")).toBe(true);
    expect(matchesGlob("spec-engine/BILLING/", "spec-engine/BILLING/deep/nested/x.json")).toBe(
      true,
    );
    expect(matchesGlob("spec-engine/BILLING/", "spec-engine/OTHER/SPEC.json")).toBe(false);
  });

  test("* matches within a single segment and does NOT cross /", () => {
    expect(matchesGlob("spec-engine/*.json", "spec-engine/manifest.json")).toBe(true);
    expect(matchesGlob("spec-engine/*.json", "spec-engine/BILLING/manifest.json")).toBe(false);
  });

  test("a bare * (and **) is a global-owner rule matching any nested path", () => {
    expect(matchesGlob("*", "spec-engine/BILLING/SPEC.json")).toBe(true);
    expect(matchesGlob("*", "a.txt")).toBe(true);
    expect(matchesGlob("**", "deep/nested/x.json")).toBe(true);
    expect(matchesGlob("**/", "deep/nested/x.json")).toBe(true);
  });

  test("ownersForPath resolves a bare-* fallback owner for a nested file", () => {
    const rules = [{ pattern: "*", owners: ["@fallback"] }];
    expect(ownersForPath(rules, "spec-engine/BILLING/SPEC.json")).toEqual(["@fallback"]);
  });

  test("a ReDoS-shaped pattern of many * segments returns promptly", () => {
    const pattern = `${"*/".repeat(40)}x`;
    const path = `${"a/".repeat(40)}b`;
    expect(matchesGlob(pattern, path)).toBe(false);
  });
});
