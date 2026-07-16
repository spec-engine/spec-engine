// packages/engine/test/authoring-edit.test.ts
//
// L2/L3 (lifecycle pass) — unit tests for authoring/edit.ts. As of 17-05
// the Markdown text helpers (getEntry / setHeadingStatus / setEntryField /
// bumpSpecVersion / bumpUpdated) are RETIRED: `spec amend` and `spec
// supersede` now mutate the domain OBJECT and write through the single
// validateAndWrite seam (VAL-01), so those helpers have no remaining caller
// and are deleted. `localToday()` stays — it is the shared date source for
// req / amend / supersede — and is the only surface left to cover here.

import { describe, expect, test } from "bun:test";
import { localToday } from "../src/authoring/edit";

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

  test("uses local calendar fields, not toISOString (WR-05)", () => {
    // localToday must reflect the LOCAL day — never the UTC date that
    // toISOString() would roll forward to past UTC midnight.
    const d = new Date();
    const localDay = String(d.getDate()).padStart(2, "0");
    expect(localToday().endsWith(localDay)).toBe(true);
  });
});
