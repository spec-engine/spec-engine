import { describe, expect, test } from "bun:test";
import { localToday } from "./edit";

describe("localToday", () => {
  test("returns today's date as YYYY-MM-DD in the LOCAL timezone", () => {
    const d = new Date();
    const expected =
      `${d.getFullYear()}-` +
      `${String(d.getMonth() + 1).padStart(2, "0")}-` +
      `${String(d.getDate()).padStart(2, "0")}`;
    expect(localToday()).toBe(expected);
    expect(localToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("uses local calendar fields, not toISOString", () => {
    const d = new Date();
    const localDay = String(d.getDate()).padStart(2, "0");
    expect(localToday().endsWith(localDay)).toBe(true);
  });
});
