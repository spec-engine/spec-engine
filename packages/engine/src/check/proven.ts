// Results ingestion happens after `runIndex` computes `build_id` and never
// touches parse diagnostics, so a proof verdict cannot move `build_id` or the
// planted-fixture baseline. Rows are returned unsorted: `sortDiagnostics`
// owns ordering.
//
// Correlation: a tag carries no test name, so the join is the file path. A
// tag's file is `${repo}/${repoRelativePath}`; a JUnit testcase's file is
// whatever the runner emitted (repo-relative, cwd-relative, or absolute). A
// tag matches a testcase file when one segment array is a suffix of the other
// on segment boundaries, which absorbs both prefixes without hard-coding repo
// names and stops `foo/bar.ts` matching `barbar.ts`. The longest suffix wins;
// two distinct files tied at that length fail closed to 'absent' rather than
// binding to an arbitrary file and gating CI on a possibly wrong verdict.
//
// Within the winning file the status is file-level: any `fail` sinks the
// proof, else one `pass` proves it, and a skip-only file proves nothing.
// Line proximity may only confirm a pass, never rescue a failure or hide a
// real pass behind a nearer skip.

import type { Diagnostic, Requirement, Tag } from "@spec-engine/shared";
import { DiagnosticCode } from "@spec-engine/shared";
import type { TestCaseResult } from "../results/junit";

export type Verdict = "pass" | "fail" | "absent";

// Case-sensitive on purpose: no lower-casing.
export function normalizeToSegments(path: string): string[] {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    out.push(seg);
  }
  return out;
}

export function commonSuffixLen(a: readonly string[], b: readonly string[]): number {
  let i = a.length - 1;
  let j = b.length - 1;
  let n = 0;
  while (i >= 0 && j >= 0 && a[i] === b[j]) {
    n++;
    i--;
    j--;
  }
  return n;
}

// 0 means no match; a zero-length path never matches.
function suffixMatchLen(tagSegs: readonly string[], fileSegs: readonly string[]): number {
  const shorter = Math.min(tagSegs.length, fileSegs.length);
  if (shorter === 0) return 0;
  const csl = commonSuffixLen(tagSegs, fileSegs);
  return csl === shorter ? csl : 0;
}

function reduceStatus(cases: readonly TestCaseResult[]): Verdict {
  let sawPass = false;
  for (const c of cases) {
    if (c.status === "fail") return "fail";
    if (c.status === "pass") sawPass = true;
  }
  return sawPass ? "pass" : "absent";
}

// Several testcases in one file are not a tie: the Set collapses them. Null on
// no match or on a tie between distinct files (fail closed).
function selectWinningFile(
  tagSegs: readonly string[],
  results: readonly TestCaseResult[],
): string | null {
  let bestLen = 0;
  const bestFiles = new Set<string>();
  for (const r of results) {
    const len = suffixMatchLen(tagSegs, normalizeToSegments(r.file));
    if (len === 0) continue;
    if (len > bestLen) {
      bestLen = len;
      bestFiles.clear();
      bestFiles.add(r.file);
    } else if (len === bestLen) {
      bestFiles.add(r.file);
    }
  }
  if (bestFiles.size !== 1) return null;
  const [only] = bestFiles;
  return only ?? null;
}

// Null falls through to file-level `reduceStatus`. Only some runners emit
// testcase lines (bun and pytest do; jest and go-junit-report do not).
function refineByLineProximity(
  fileCases: readonly TestCaseResult[],
  tagLine: number,
): Verdict | null {
  if (!fileCases.some((c) => c.line !== null)) return null;
  // Checked before proximity: a nearest-line pass must never mask a failing
  // verifying test elsewhere in the file.
  if (reduceStatus(fileCases) === "fail") return "fail";
  // The `@spec` comment precedes its `test(...)`, so look at-or-after it.
  let nearest: TestCaseResult | null = null;
  for (const c of fileCases) {
    if (c.line === null || c.line < tagLine) continue;
    if (nearest === null || c.line < (nearest.line as number)) nearest = c;
  }
  if (nearest !== null && nearest.status === "pass") return "pass";
  // A nearer skip must not hide a real pass elsewhere in the file.
  return null;
}

export function correlateTag(tag: Tag, results: readonly TestCaseResult[]): Verdict {
  const tagSegs = normalizeToSegments(tag.file);

  const bestFile = selectWinningFile(tagSegs, results);
  if (bestFile === null) return "absent";

  const fileCases = results.filter((r) => r.file === bestFile);

  const refined = refineByLineProximity(fileCases, tag.line);
  if (refined !== null) return refined;

  return reduceStatus(fileCases);
}

// `verifyingTags` arrive pre-filtered to `kind === "verifies"`; the filter
// below guards anyway, as does the status check for a direct unit call.
// @spec PROOF-020
export function provenDetermination(
  active: readonly Requirement[],
  verifyingTags: readonly Tag[],
  results: readonly TestCaseResult[],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const r of active) {
    if (r.status !== "Active") continue;

    const tags = verifyingTags.filter((t) => t.req_id === r.id && t.kind === "verifies");
    // A req with no verifying tag belongs to UNVERIFIED_REQ / ORPHAN_REQ.
    if (tags.length === 0) continue;

    const proven = tags.some((t) => correlateTag(t, results) === "pass");
    if (proven) continue;

    out.push({
      code: DiagnosticCode.UNPROVEN_REQ,
      source_file: r.source_file,
      line: r.line,
      repo: null,
      req_id: r.id,
      detail: `${r.id} has a verifying @spec tag but no passing correlated test in the supplied results`,
      severity: "error",
    });
  }
  return out;
}

// Warning severity so a check without `--results` keeps its exit code.
export function proofsUnconfirmedWarning(): Diagnostic {
  return {
    // @spec PROOF-018
    code: DiagnosticCode.PROOFS_UNCONFIRMED,
    source_file: null,
    line: null,
    repo: null,
    req_id: null,
    detail:
      "no --results supplied; proofs unconfirmed — run with --results <junit.xml> to enforce trusted-red",
    severity: "warning",
  };
}
