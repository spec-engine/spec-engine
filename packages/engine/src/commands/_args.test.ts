// packages/engine/src/commands/_args.test.ts
//
// @spec REQ-042 unit

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

  test("does not read a different flag that shares the prefix", () => {
    expect(listFlag(["--livesX", "a.ts"], "lives", undefined)).toBeUndefined();
  });
});
