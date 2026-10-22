// @spec REQ-042 unit
// @spec REQ-056 unit

import { describe, expect, test } from "bun:test";
import { listFlag } from "./_args";

describe("listFlag", () => {
  test("collects every occurrence, in order, from argv", () => {
    expect(listFlag(["--lives", "a.ts", "--why", "w", "--lives", "b.ts"], "lives", "b.ts")).toEqual(
      ["a.ts", "b.ts"],
    );
  });

  test("splits comma-separated values, trims, and drops empties", () => {
    expect(listFlag(["--lives", " a.ts , b.ts,,", "--lives=c.ts"], "lives", undefined)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });

  test("falls back to the parsed value when argv carries none", () => {
    expect(listFlag([], "lives", "a.ts,b.ts")).toEqual(["a.ts", "b.ts"]);
  });

  test("an empty value is an empty list; an absent flag is undefined", () => {
    expect(listFlag(["--lives", ""], "lives", "")).toEqual([]);
    expect(listFlag(["--why", "w"], "lives", undefined)).toBeUndefined();
  });

  test("reads --tests the way it reads --lives, ignoring the other flag", () => {
    expect(
      listFlag(["--tests", " a.test.ts ,", "--lives", "a.ts", "--tests=b.test.ts"], "tests", ""),
    ).toEqual(["a.test.ts", "b.test.ts"]);
  });

  test("does not read a different flag that shares the prefix", () => {
    expect(listFlag(["--livesX", "a.ts"], "lives", undefined)).toBeUndefined();
  });
});
