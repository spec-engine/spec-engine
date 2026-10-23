// @spec PROOF-019 unit
import { describe, expect, test } from "bun:test";
import type { Tag } from "@spec-engine/shared";
import type { TestCaseResult } from "../results/junit";
import { commonSuffixLen, correlateTag, normalizeToSegments } from "./proven";

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
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts" });
    const results = [
      mkResult({ file: "renew.e2e.test.ts", line: null, status: "pass" }),
      mkResult({
        file: "/abs/scratch/api/test/renew.e2e.test.ts",
        line: null,
        status: "fail",
      }),
    ];
    expect(correlateTag(tag, results)).toBe("fail");
  });

  test("two distinct files tying at the longest suffix → ambiguous → fail closed ('absent')", () => {
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts" });
    const results = [
      mkResult({ file: "/y/api/test/renew.e2e.test.ts", line: null, status: "fail" }),
      mkResult({ file: "/x/api/test/renew.e2e.test.ts", line: null, status: "pass" }),
    ];
    expect(correlateTag(tag, results)).toBe("absent");
  });

  test("ambiguity fails closed even when both tied files pass (it is about the tie, not the verdict)", () => {
    const tag = mkTag({ file: "renew.e2e.test.ts" });
    const results = [
      mkResult({ file: "a/renew.e2e.test.ts", line: null, status: "pass" }),
      mkResult({ file: "b/renew.e2e.test.ts", line: null, status: "pass" }),
    ];
    expect(correlateTag(tag, results)).toBe("absent");
  });

  test("multiple testcases sharing ONE file are NOT a tie (Set collapses them)", () => {
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

  test("line-proximity confirms the nearest at-or-after pass when the file has no failure", () => {
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts", line: 10 });
    const results = [
      mkResult({ file: "api/test/renew.e2e.test.ts", name: "earlier", line: 4, status: "pass" }),
      mkResult({ file: "api/test/renew.e2e.test.ts", name: "target", line: 12, status: "pass" }),
    ];
    expect(correlateTag(tag, results)).toBe("pass");
  });

  test("a correlated fail in the winning file sinks the proof even when a nearer test passes", () => {
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

  test("nearest-line pass must NOT report PROVEN when a later correlated test fails", () => {
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

  test("a real pass must NOT be hidden by a nearer skip", () => {
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
    const tag = mkTag({ file: "api/test/renew.e2e.test.ts", line: 99 });
    const results = [
      mkResult({ file: "api/test/renew.e2e.test.ts", name: "a", line: 4, status: "pass" }),
      mkResult({ file: "api/test/renew.e2e.test.ts", name: "b", line: 12, status: "fail" }),
    ];
    expect(correlateTag(tag, results)).toBe("fail");
  });

  test("line-proximity degrades to file-level when testcases carry no line", () => {
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
