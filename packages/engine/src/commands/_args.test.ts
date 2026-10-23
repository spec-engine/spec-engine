// @spec REQ-077 unit

import { describe, expect, test } from "bun:test";
import { listFlag } from "./_args";

describe("listFlag", () => {
  test("collects every occurrence, in order, from argv", () => {
    expect(
      listFlag(["--relates", "A-1", "--why", "w", "--relates", "A-2"], "relates", "A-2"),
    ).toEqual(["A-1", "A-2"]);
  });

  test("splits comma-separated values, trims, and drops empties", () => {
    expect(listFlag(["--relates", " A-1 , A-2,,", "--relates=A-3"], "relates", undefined)).toEqual([
      "A-1",
      "A-2",
      "A-3",
    ]);
  });

  test("falls back to the parsed value when argv carries none", () => {
    expect(listFlag([], "relates", "A-1,A-2")).toEqual(["A-1", "A-2"]);
  });

  test("an empty value is an empty list; an absent flag is undefined", () => {
    expect(listFlag(["--relates", ""], "relates", "")).toEqual([]);
    expect(listFlag(["--why", "w"], "relates", undefined)).toBeUndefined();
  });

  test("does not read a different flag that shares the prefix", () => {
    expect(listFlag(["--relatesX", "A-1"], "relates", undefined)).toBeUndefined();
  });
});
