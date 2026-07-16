// packages/engine/test/proven-correlate.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec PROOF-001 unit
//
// GATE-01 (correlation half) unit cases for the pure `correlateTag()` helper.
// Drives the function directly with synthetic Tag[] + TestCaseResult[] inputs —
// no Storage, no bun:sqlite, no fixtures. Correlation is the crux: tags carry
// file+line+kind but NO test name, so the load-bearing join is a normalized
// path (longest-common-suffix on segment boundaries) with line-proximity as a
// refinement only when both sides emit a line.

import { describe, expect, test } from "bun:test";
import type { Tag } from "@spec-engine/shared";
import { commonSuffixLen, correlateTag, normalizeToSegments } from "../src/check/proven";
import type { TestCaseResult } from "../src/results/junit";

// Synthetic verifying-tag builder (mirrors unsourced.test.ts mkReq style).
function mkTag(over: Partial<Tag>): Tag {
  return {
    id: 1,
    req_id: "BILLING-009",
    repo: "api",
    file: "api/test/renew.e2e.test.ts",
    line: 10,
    kind: "verifies",
    level: "e2e",
    ...over,
  };
}

// Synthetic testcase builder.
function mkResult(over: Partial<TestCaseResult>): TestCaseResult {
  return {
    file: "api/test/renew.e2e.test.ts",
    name: "renews on charge",
    line: 12,
    status: "pass",
    ...over,
  };
}

describe("normalizeToSegments() (path → comparable segments)", () => {
  test("splits on '/' and drops empty + '.' segments", () => {
    expect(normalizeToSegments("api/test/renew.ts")).toEqual(["api", "test", "renew.ts"]);
    expect(normalizeToSegments("/abs//scratch/./api/x.ts")).toEqual([
      "abs",
      "scratch",
      "api",
      "x.ts",
    ]);
    expect(normalizeToSegments("")).toEqual([]);
  });
});

describe("commonSuffixLen() (matching segments from the end)", () => {
  test("counts matching trailing segments", () => {
    expect(commonSuffixLen(["a", "b", "c"], ["x", "b", "c"])).toBe(2);
    expect(commonSuffixLen(["a", "b", "c"], ["a", "b", "c"])).toBe(3);
    expect(commonSuffixLen(["foo", "bar.ts"], ["barbar.ts"])).toBe(0);
    expect(commonSuffixLen([], ["a"])).toBe(0);
  });
});

describe("correlateTag() (tag ↔ testcase verdict)", () => {
  test("absolute junit path suffix-matches a repo-relative tag → 'pass' when green", () => {
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts" });
    const results = [
      mkResult({ file: "/tmp/x/api/test/renew.e2e.test.ts", line: null, status: "pass" }),
    ];
    expect(correlateTag(tag, results)).toBe("pass");
  });

  test("repo-relative junit path (shorter than tag) also suffix-matches", () => {
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts" });
    const results = [mkResult({ file: "test/renew.e2e.test.ts", line: null, status: "pass" })];
    expect(correlateTag(tag, results)).toBe("pass");
  });

  test("segment-boundary guard: 'foo/bar.ts' does NOT correlate to 'barbar.ts'", () => {
    const tag = mkTag({ file: "foo/bar.ts" });
    const results = [mkResult({ file: "barbar.ts", line: null, status: "pass" })];
    expect(correlateTag(tag, results)).toBe("absent");
  });

  test("longest-common-suffix tie-break: the deeper matching file wins", () => {
    // Both files suffix-match the tag; the absolute (3-segment overlap) file is
    // failing, the shallow (2-segment overlap) file is passing. Longest-common-
    // suffix picks the absolute file → verdict 'fail'.
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts" });
    const results = [
      mkResult({ file: "renew.e2e.test.ts", line: null, status: "pass" }), // suffix len 1
      mkResult({
        file: "/abs/scratch/api/test/renew.e2e.test.ts", // suffix len 3
        line: null,
        status: "fail",
      }),
    ];
    expect(correlateTag(tag, results)).toBe("fail");
  });

  test("WR-04: two distinct files tying at the longest suffix → ambiguous → fail closed ('absent')", () => {
    // Two distinct absolute files each FULLY suffix-match the 3-segment tag
    // (common-suffix length 3) but disagree (one fail, one pass). Rather than
    // silently binding to the lexicographically-smallest file, the ambiguous
    // correlation fails closed → 'absent' (the req stays unproven).
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts" });
    const results = [
      mkResult({ file: "/y/api/test/renew.e2e.test.ts", line: null, status: "fail" }),
      mkResult({ file: "/x/api/test/renew.e2e.test.ts", line: null, status: "pass" }),
    ];
    expect(correlateTag(tag, results)).toBe("absent");
  });

  test("WR-04: ambiguity fails closed even when both tied files pass (it is about the tie, not the verdict)", () => {
    // A short tag path (1 segment) suffix-matches two distinct files at length 1.
    // Even though both pass, we refuse to bind — the correlation is ambiguous.
    const tag = mkTag({ file: "renew.e2e.test.ts" });
    const results = [
      mkResult({ file: "a/renew.e2e.test.ts", line: null, status: "pass" }),
      mkResult({ file: "b/renew.e2e.test.ts", line: null, status: "pass" }),
    ];
    expect(correlateTag(tag, results)).toBe("absent");
  });

  test("WR-04: multiple testcases sharing ONE file are NOT a tie (Set collapses them)", () => {
    // Two testcases, same file, same suffix length — not ambiguous. The
    // fail-closed guard must not trip on repeated testcases of one file.
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts" });
    const results = [
      mkResult({ file: "/x/api/test/renew.e2e.test.ts", name: "a", line: null, status: "pass" }),
      mkResult({ file: "/x/api/test/renew.e2e.test.ts", name: "b", line: null, status: "pass" }),
    ];
    expect(correlateTag(tag, results)).toBe("pass");
  });

  test("any failing testcase in the matched file sinks the proof (file-level)", () => {
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts" });
    const results = [
      mkResult({ file: "api/test/renew.e2e.test.ts", name: "a", line: null, status: "pass" }),
      mkResult({ file: "api/test/renew.e2e.test.ts", name: "b", line: null, status: "fail" }),
    ];
    expect(correlateTag(tag, results)).toBe("fail");
  });

  test("skip ≠ pass: a file whose only testcase is <skipped> → 'absent'", () => {
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts" });
    const results = [mkResult({ file: "api/test/renew.e2e.test.ts", line: null, status: "skip" })];
    expect(correlateTag(tag, results)).toBe("absent");
  });

  test("file absent from results → 'absent'", () => {
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts" });
    const results = [mkResult({ file: "other/thing.test.ts", line: null, status: "pass" })];
    expect(correlateTag(tag, results)).toBe("absent");
  });

  test("empty results → 'absent'", () => {
    expect(correlateTag(mkTag({}), [])).toBe("absent");
  });

  test("WR-02: line-proximity confirms the nearest at-or-after pass when the file has no failure", () => {
    // @spec comment at line 10; two PASSING testcases — one below the comment
    // (line 4) and the tag's actual test at/after (line 12). No failure present,
    // so line-proximity confirms the pass → 'pass'.
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts", line: 10 });
    const results = [
      mkResult({ file: "api/test/renew.e2e.test.ts", name: "earlier", line: 4, status: "pass" }),
      mkResult({ file: "api/test/renew.e2e.test.ts", name: "target", line: 12, status: "pass" }),
    ];
    expect(correlateTag(tag, results)).toBe("pass");
  });

  test("WR-02: a correlated fail in the winning file sinks the proof even when a nearer test passes", () => {
    // The exact false-green the fix closes: an unrelated PASSING test sits just
    // after the @spec comment (line 12) while the real verifying test FAILS
    // below (line 4 here plays the failing role). The old refinement narrowed to
    // the nearest passing test and reported PROVEN, masking the failure. The
    // file-level "any fail sinks" rule is absolute → 'fail'.
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts", line: 10 });
    const results = [
      mkResult({
        file: "api/test/renew.e2e.test.ts",
        name: "verifying fail",
        line: 4,
        status: "fail",
      }),
      mkResult({
        file: "api/test/renew.e2e.test.ts",
        name: "nearer pass",
        line: 12,
        status: "pass",
      }),
    ];
    expect(correlateTag(tag, results)).toBe("fail");
  });

  test("WR-02: nearest-line pass must NOT report PROVEN when a later correlated test fails", () => {
    // Passing but unrelated test just after the @spec comment (line 11); the
    // real verifying test fails further down (line 20). Nearest-line pass must
    // not upgrade the verdict — any correlated fail sinks it.
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts", line: 10 });
    const results = [
      mkResult({
        file: "api/test/renew.e2e.test.ts",
        name: "unrelated pass",
        line: 11,
        status: "pass",
      }),
      mkResult({
        file: "api/test/renew.e2e.test.ts",
        name: "verifying fail",
        line: 20,
        status: "fail",
      }),
    ];
    expect(correlateTag(tag, results)).toBe("fail");
  });

  test("WR-02: a real pass must NOT be hidden by a nearer skip", () => {
    // The nearest test at-or-after the @spec comment is a `skip` (line 11); the
    // real passing verifying test is further down (line 20). The old code
    // returned reduceStatus([skip]) === 'absent' and stopped — a false red.
    // Conservative semantics fall through to file-level → the real pass wins.
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts", line: 10 });
    const results = [
      mkResult({
        file: "api/test/renew.e2e.test.ts",
        name: "nearer skip",
        line: 11,
        status: "skip",
      }),
      mkResult({ file: "api/test/renew.e2e.test.ts", name: "real pass", line: 20, status: "pass" }),
    ];
    expect(correlateTag(tag, results)).toBe("pass");
  });

  test("line-proximity degrades to file-level when no testcase is at-or-after the comment", () => {
    // tag.line 99 is past every testcase → no at-or-after candidate → file-level,
    // where a fail is present → 'fail'.
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts", line: 99 });
    const results = [
      mkResult({ file: "api/test/renew.e2e.test.ts", name: "a", line: 4, status: "pass" }),
      mkResult({ file: "api/test/renew.e2e.test.ts", name: "b", line: 12, status: "fail" }),
    ];
    expect(correlateTag(tag, results)).toBe("fail");
  });

  test("line-proximity degrades to file-level when testcases carry no line", () => {
    // tag has a line but the runner (jest) emitted no testcase lines → file-level.
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts", line: 10 });
    const results = [
      mkResult({ file: "api/test/renew.e2e.test.ts", name: "a", line: null, status: "pass" }),
      mkResult({ file: "api/test/renew.e2e.test.ts", name: "b", line: null, status: "fail" }),
    ];
    expect(correlateTag(tag, results)).toBe("fail");
  });

  test("does not mutate its inputs", () => {
    const tag = mkTag({ line: 10 });
    const results = [mkResult({})];
    const tagSnap = JSON.stringify(tag);
    const resSnap = JSON.stringify(results);
    correlateTag(tag, results);
    expect(JSON.stringify(tag)).toBe(tagSnap);
    expect(JSON.stringify(results)).toBe(resSnap);
  });
});
