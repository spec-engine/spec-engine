// packages/engine/src/check/proven.ts
//
// GATE-01 (correlation half) / GATE-02: the pure, cold-build-safe PROVEN
// detector. It correlates a verifying `@spec` tag to a JUnit `<testcase>` by
// NORMALIZED path and, from that, decides whether an active requirement is
// PROVEN (≥1 verifying tag whose test PASSED) or emits `UNPROVEN_REQ`.
//
// Off-by-default seam (Phase 19 rationale, mirrors check/unsourced.ts): this is
// a side-effect-free projection over already-fetched rows. It is NOT routed
// through `validateStructure` / the `parse_diagnostics` store, and results
// ingestion happens AFTER `runIndex` computes `build_id` — so PROVEN can never
// perturb `build_id`, the cold-rebuild byte-identity, or the inverted-CI
// baseline (GATE-04 upheld by construction). PROVEN is a check-time projection,
// never a materialized column/VIEW — computed fresh, stored nowhere.
//
// Mirrors the pure-function pattern of check/unsourced.ts + check/format.ts:
// rows in, `Diagnostic[]` out, no Storage, no I/O, NO sort (downstream
// `sortDiagnostics` in format.ts owns ordering — Pitfall 3).
//
// D-08 grep-fence: this file imports no SQLite runtime — no Storage, no DB.
//
// ── Correlation determinism (the crux; T-19-10) ─────────────────────────────
// Tags carry `file`+`line`+`kind` but NO test name, so the load-bearing join is
// the file path. The two `file` forms differ: a tag's file is
// `${repo}/${repoRelativePath}` (e.g. `api/test/renew.e2e.test.ts`) while a
// JUnit testcase's file is whatever path the runner emitted (repo-relative,
// cwd-relative, or ABSOLUTE). We reconcile them WITHOUT hard-coding repo names:
//
//   1. Normalize both to POSIX segment arrays (split on `/`, drop empty + `.`).
//   2. A tag correlates to a testcase file iff one segment array is a SUFFIX of
//      the other ON SEGMENT BOUNDARIES — i.e. `commonSuffixLen === min(len)`.
//      The suffix rule absorbs both the tag-side `${repo}/` prefix and the
//      junit-side absolute prefix, and the segment-boundary guard stops
//      `foo/bar.ts` spuriously matching `barbar.ts`.
//   3. If a tag suffix-matches multiple distinct files, pick the file with the
//      LONGEST common suffix. If two DISTINCT files tie at that longest suffix,
//      the correlation is genuinely AMBIGUOUS: FAIL CLOSED (WR-04) — return
//      'absent' (leave the req unproven) rather than silently binding to the
//      lexicographically-smallest file and emitting a possibly-wrong CI-gating
//      PROVEN/UNPROVEN verdict. A given (tag, results) input therefore always
//      yields the same verdict. (Longer tag paths `${repo}/${repoRelativePath}`
//      make ties rare in practice, but short tag paths must not be assumed.)
//
// Status within the winning file is FILE-LEVEL (the correctness-bearing rule,
// portable across every runner): any `fail` sinks the proof; else ≥1 `pass` is
// proven; a file whose only testcases are `skip` proves NOTHING (skip ≠ pass,
// Pitfall 5) → 'absent'. Line-proximity is a CONSERVATIVE refinement (WR-02):
// it may only CONFIRM a pass, never rescue one — the file-level "any fail
// sinks" rule is ABSOLUTE, so a correlated failure anywhere in the winning file
// always withholds the proof regardless of which testcase sits nearest the
// `@spec` comment. With no failure present it narrows to the nearest testcase
// at-or-after the comment to confirm a pass; if the nearest is a skip/absent it
// degrades to file-level rather than masking a real passing test elsewhere. It
// can therefore never upgrade a failing/absent verdict to passing, nor hide a
// real pass behind a nearer skip.

import type { Diagnostic, Requirement, Tag } from "@spec-engine/shared";
import { DiagnosticCode } from "@spec-engine/shared";
import type { TestCaseResult } from "../results/junit";

/** The verdict for a single verifying tag against the whole results set. */
export type Verdict = "pass" | "fail" | "absent";

/** Split a path into comparable POSIX segments: split on `/`, drop empty and
 *  `.` segments. Deterministic and case-sensitive (no lower-casing). */
export function normalizeToSegments(path: string): string[] {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    out.push(seg);
  }
  return out;
}

/** Count matching segments from the END of both arrays (the common suffix). */
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

/** True iff `tagSegs` and `fileSegs` share a suffix that fully covers the
 *  shorter of the two — i.e. one path is a suffix of the other on segment
 *  boundaries. Zero-length paths never match. Returns the common-suffix length
 *  on a match, or 0 on no match. */
function suffixMatchLen(tagSegs: readonly string[], fileSegs: readonly string[]): number {
  const shorter = Math.min(tagSegs.length, fileSegs.length);
  if (shorter === 0) return 0;
  const csl = commonSuffixLen(tagSegs, fileSegs);
  return csl === shorter ? csl : 0;
}

/** Reduce a set of correlated testcases to a single file-level verdict:
 *  any `fail` → 'fail'; else ≥1 `pass` → 'pass'; else (only skips) → 'absent'
 *  (skip ≠ pass). */
function reduceStatus(cases: readonly TestCaseResult[]): Verdict {
  let sawPass = false;
  for (const c of cases) {
    if (c.status === "fail") return "fail";
    if (c.status === "pass") sawPass = true;
  }
  return sawPass ? "pass" : "absent";
}

/**
 * Select the single winning testcase file for a tag. Among all testcase files
 * whose segments suffix-match `tagSegs`, the LONGEST common suffix wins. Track
 * the set of DISTINCT files at the current best length so we can detect a
 * genuine tie (WR-04). Multiple testcases sharing ONE file are not a tie — the
 * Set collapses them.
 *
 * Returns the winning file path, or null when nothing suffix-matches OR when >1
 * DISTINCT file ties at the longest suffix — a genuine ambiguity. We cannot know
 * which file proves the req,
 * so fail closed (return null → caller returns 'absent') rather than silently
 * binding to one arbitrary (lexicographically-smallest) file and emitting a
 * possibly-wrong error-severity verdict. Pure: never mutates its inputs, no I/O.
 */
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
  // No suffix match at all → null; exactly-one distinct file → that file; a
  // WR-04 >1-distinct-file tie → null (fail closed). Both null cases collapse to
  // the caller's 'absent'.
  if (bestFiles.size !== 1) return null;
  return bestFiles.values().next().value as string;
}

/**
 * Line-proximity refinement — CONSERVATIVE (WR-02): it may only ever make the
 * verdict MORE cautious, never rescue a proof. Returns a Verdict when the
 * refinement decides, or null to signal "fall through to file-level
 * `reduceStatus`".
 *
 * A tag ALWAYS carries a line (`Tag.line` is non-nullable), so the guard reduces
 * to "≥1 candidate testcase carries a line" (bun/pytest emit lines;
 * jest/go-junit-report do not). Pure: never mutates its inputs, no I/O.
 */
function refineByLineProximity(
  fileCases: readonly TestCaseResult[],
  tagLine: number,
): Verdict | null {
  if (!fileCases.some((c) => c.line !== null)) return null;
  // Any correlated fail in the winning file ALWAYS sinks the proof — the
  // file-level rule is absolute and line-proximity must not override it.
  // (Returning `reduceStatus([nearest])` unconditionally was the false-green
  // that let a nearest-line pass mask a failing verifying test.)
  if (reduceStatus(fileCases) === "fail") return "fail";
  // No failure present: narrow to the nearest testcase at-or-after the `@spec`
  // comment line (the comment precedes `test(...)`) ONLY to confirm a pass.
  let nearest: TestCaseResult | null = null;
  for (const c of fileCases) {
    if (c.line === null || c.line < tagLine) continue;
    if (nearest === null || c.line < (nearest.line as number)) nearest = c;
  }
  if (nearest !== null && nearest.status === "pass") return "pass";
  // A nearest skip/absent must NOT mask a real pass elsewhere in the file, nor
  // manufacture an 'absent' verdict — fall through to file-level.
  return null;
}

/**
 * Correlate one verifying tag to the results set and return its verdict
 * ('pass' | 'fail' | 'absent'). See the file header for the full determinism
 * contract. Pure: never mutates its inputs, no I/O.
 *
 * Orchestration: normalize the tag path → select the winning file (fail-closed
 * to 'absent' on no-match or tie) → gather that file's testcases →
 * run the conservative line-proximity refinement (its Verdict when non-null) →
 * else the file-level `reduceStatus`.
 */
export function correlateTag(tag: Tag, results: readonly TestCaseResult[]): Verdict {
  const tagSegs = normalizeToSegments(tag.file);

  // 1. Select the winning file (LONGEST-suffix; a distinct-file tie fails closed).
  const bestFile = selectWinningFile(tagSegs, results);
  if (bestFile === null) return "absent";

  // 2. Gather the winning file's testcases.
  const fileCases = results.filter((r) => r.file === bestFile);

  // 3. Line-proximity refinement (CONSERVATIVE); null → fall through.
  const refined = refineByLineProximity(fileCases, tag.line);
  if (refined !== null) return refined;

  // 4. File-level status.
  return reduceStatus(fileCases);
}

/**
 * GATE-02: for each ACTIVE requirement that HAS ≥1 verifying tag but no
 * verifying tag correlating to a PASSING testcase, emit exactly one
 * error-severity `UNPROVEN_REQ` diagnostic.
 *
 * Scope discipline (Pitfall 6, no double-diagnosis): a req with ZERO verifying
 * tags is skipped entirely — that case belongs to UNVERIFIED_REQ (Q5) /
 * ORPHAN_REQ (Q4), never UNPROVEN_REQ. `UNPROVEN_REQ` sits strictly DOWNSTREAM
 * of "a verifying tag exists".
 *
 * PROVEN iff ≥1 verifying tag's verdict is 'pass'. A failing or absent file, or
 * a skip-only file (skip ≠ pass), leaves the req unproven.
 *
 * `verifyingTags` are expected pre-filtered to `kind === "verifies"` by the
 * caller; we still guard defensively. Pure: never mutates inputs, no I/O, and
 * does NOT sort (downstream `sortDiagnostics` owns order — Pitfall 3).
 */
// @spec PROOF-002
export function provenDetermination(
  active: readonly Requirement[],
  verifyingTags: readonly Tag[],
  results: readonly TestCaseResult[],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const r of active) {
    // Belt-and-suspenders: only ACTIVE reqs self-gate (a non-active req can
    // never be UNPROVEN_REQ). The caller pre-filters, but a direct unit call
    // might not.
    if (r.status !== "Active") continue;

    const tags = verifyingTags.filter((t) => t.req_id === r.id && t.kind === "verifies");
    // No verifying tag → Q4/Q5 own this req; UNPROVEN_REQ stays silent
    // (Pitfall 6 — no double-diagnosis).
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

/**
 * GATE-05 fallback: the single warning-severity `PROOFS_UNCONFIRMED` diagnostic
 * emitted when `spec check` runs WITHOUT `--results`. All locator fields are
 * null (it is a platform-wide advisory, not tied to any req/file). Warning
 * severity so the `severity === "error"` exit predicate is unaffected — today's
 * exit code is byte-preserved for every existing invocation.
 */
export function proofsUnconfirmedWarning(): Diagnostic {
  return {
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
