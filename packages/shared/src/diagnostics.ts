// packages/shared/src/diagnostics.ts
//
// Diagnostic codes for the Spec Engine derived index. Used by Phase 2 (validate-on-parse)
// and Phase 3 (integrity check) to report structural issues with file+line context.
// `as const` object (not TS `enum`) so it survives verbatimModuleSyntax: true.

export const DiagnosticCode = {
  DUP_ID: "DUP_ID",
  BROKEN_SUPERSEDE: "BROKEN_SUPERSEDE",
  BAD_STATUS: "BAD_STATUS",
  DANGLING_TAG: "DANGLING_TAG",
  SUPERSEDED_REFERENCED: "SUPERSEDED_REFERENCED",
  ORPHAN_REQ: "ORPHAN_REQ",
  UNVERIFIED_REQ: "UNVERIFIED_REQ",
  DRIFT: "DRIFT",
  NO_SPEC_CONFIG: "NO_SPEC_CONFIG",
  // 260605-tqz (D-03 / AUTHC-025): an `@<relative/path>` file reference in
  // requirement field text does not resolve to an existing file under the
  // platform root (traversal refs resolving OUTSIDE the root are also
  // broken). Warning severity — authored prose may legitimately lag code.
  BROKEN_FILE_REF: "BROKEN_FILE_REF",
  // RED-16: a `**Relates:**` entry points at a requirement id that does not
  // exist in the index. Warning severity — relations are advisory links,
  // not load-bearing supersession chains (contrast BROKEN_SUPERSEDE).
  BROKEN_RELATES: "BROKEN_RELATES",
  // RED-16: a `**Relates:**` entry points at a requirement that has since
  // been SUPERSEDED — the related req changed, so the relation surfaces for
  // review (the whole point of the field). Warning severity.
  RELATES_SUPERSEDED: "RELATES_SUPERSEDED",
  // Audit hygiene pass T6: a supersession chain loops (`A → B → A`, or
  // `A → A`). The chain IS the change history, so a cycle is corrupt
  // history — error severity, matching BROKEN_SUPERSEDE. Without this the
  // propagation CTE just stops at its depth guard, silently.
  CYCLIC_SUPERSEDE: "CYCLIC_SUPERSEDE",
  // Audit hygiene pass T5: a `**Relates:**` token names its own requirement.
  // The parser drops it from the relations set (a self-relation carries no
  // information), but the drop is no longer silent — warning severity so
  // the author sees the line instead of wondering where the link went.
  SELF_RELATES: "SELF_RELATES",
  // UNKNOWN_ROLE — PROV-05: a `**Issues:**` token uses a role outside the closed allow-list
  // (created / supersedes-via / amends-via), or has no recognizable role:ID
  // shape (e.g. a colon-less token). Surfaced at parse time and the token is
  // NOT stored (never silently dropped — surface AND drop). Warning severity,
  // matching the advisory Relates diagnostic family (BROKEN_RELATES /
  // SELF_RELATES); does not gate `spec check --ci` exit code.
  UNKNOWN_ROLE: "UNKNOWN_ROLE",
  // USRC-01/02/03 — flags a SUPERSEDED requirement whose provenance carries
  // no `supersedes-via` issue (an "unsourced change": the spec changed but no
  // tracker issue records why). WARNING severity, so it composes with the
  // `severity === "error"` exit predicate — a warning-only platform still
  // exits 0. OFF BY DEFAULT: computed at check time ONLY when the
  // `--unsourced-change` flag is passed (Wave 2). It is NEVER written to
  // `parse_diagnostics` and NEVER routed through `validateStructure`, so it
  // does not perturb `build_id` or the cold-rebuild byte-identity / the 6-row
  // inverted-CI baseline. Adding it to the on-by-default structural/pipeline
  // path is the documented Pitfall 1 trap — do not.
  UNSOURCED_CHANGE: "UNSOURCED_CHANGE",
  // STOR-03 (Phase 17): a JSON domain file fails the STRUCTURAL tier of the
  // ONE zod schema — it is not a JSON object, its `key` is missing/malformed
  // (KEY_RE), a requirement's `id` is missing/malformed (ID_RE), a required
  // `statement` is missing/empty, `requirements` is not an array, or an
  // unrecognized (`.strict`) key was injected. ERROR severity so
  // `spec check --ci` fails on it — this is the loud, typed replacement for
  // the em-dash silent-zero-requirements failure mode. It is deliberately
  // STRUCTURAL only: a status outside the enum or an issue role outside the
  // allow-list are SEMANTIC defects that PASS this tier (so the planted mess
  // still lands) and are surfaced downstream as BAD_STATUS / UNKNOWN_ROLE
  // (Invariant #4). Both the index reader and the write seam
  // (`validateAndWrite`) emit it from the same `validateDomainFile` — one
  // validator, byte-identical diagnostics on read and write paths (VAL-02).
  INVALID_DOMAIN_FILE: "INVALID_DOMAIN_FILE",
  // GATE-02 / GATE-04 (Phase 19, trusted-red gate): an ACTIVE requirement that
  // HAS ≥1 verifying `@spec` tag but NO passing correlated `<testcase>` in the
  // supplied `--results` JUnit file — i.e. proof is present but not passing.
  // ERROR severity so `spec check --ci` exits 1 via the existing
  // `severity === "error"` predicate. Scoped to reqs that HAVE a verifying tag,
  // so it sits strictly DOWNSTREAM of UNVERIFIED_REQ (Q5) and never
  // double-diagnoses a no-tag requirement (D — Pitfall 6): a req with zero
  // verifying tags is UNVERIFIED_REQ's business, never UNPROVEN_REQ's. Computed
  // at check time ONLY when `--results` is supplied; like the other req-scoped
  // codes (ORPHAN_REQ / UNVERIFIED_REQ) it carries `repo: null` and keys on
  // `req_id`. Reuses the Diagnostic interface unchanged.
  UNPROVEN_REQ: "UNPROVEN_REQ",
  // GATE-05 (Phase 19): emitted when `spec check` runs WITHOUT `--results` —
  // the gate falls back to presence-only mode and this WARNING flags that
  // proofs are unconfirmed (enabling gradual adoption without breaking existing
  // invocations). WARNING severity so it composes with the
  // `severity === "error"` exit predicate — a proofs-unconfirmed platform still
  // exits 0. Routed to STDERR in `--json` mode so the inverted-CI `--json`
  // stdout byte-baseline (ci.yml smoke 7 / smoke 18) is byte-preserved. Reuses
  // the Diagnostic interface unchanged.
  PROOFS_UNCONFIRMED: "PROOFS_UNCONFIRMED",
  // GOV-01 (Phase 20, governance teeth): a requirement id present in the BASE
  // ref is ABSENT from the change with no approved supersession — a spec
  // requirement silently vanished. ERROR severity so `spec check` exits 1 via
  // the existing `severity === "error"` predicate. Computed at check time ONLY
  // when `--base <ref>` is supplied; it is a post-`runIndex` projection (like
  // UNPROVEN_REQ) so it NEVER perturbs `build_id`, the cold-rebuild
  // byte-identity, or the inverted-CI baseline (GATE-04 by construction). Never
  // written to `parse_diagnostics`, never routed through `validateStructure`.
  // Reuses the Diagnostic interface unchanged (no schema/storage change).
  REQUIREMENT_REMOVED: "REQUIREMENT_REMOVED",
  // GOV-02 (Phase 20): a status flip to Superseded/Retired on a spec path whose
  // CODEOWNERS domain owner is not present in `--approved-by`. This is ONE code
  // constant with a TWO-TIER runtime severity — the detector emits the emitted
  // `Diagnostic.severity` as "warning" by DEFAULT (surfaced as a PR
  // comment/annotation, does NOT fail the gate) and "error" ONLY under
  // `--require-owner-approval` (strict mode, fails the build). Do NOT create a
  // second code for the strict tier — the severity is a runtime field the
  // detector picks from a `strict: boolean` arg. Fail-closed: an empty approver
  // set → unapproved. Computed at check time ONLY when `--base` is supplied;
  // post-`runIndex` projection, never perturbs `build_id` (GATE-04). Reuses the
  // Diagnostic interface unchanged.
  UNAPPROVED_STATUS_FLIP: "UNAPPROVED_STATUS_FLIP",
  // PROP-01 (Phase 20, propagation teeth): a CHANGED active rule with ≥2
  // verifying tags where SOME correlated tests passed and some did not — a
  // partial propagation (one bound site fixed, another still red). ERROR
  // severity so `spec check` exits 1. Distinct from UNPROVEN_REQ (which is "NO
  // verifying tag passed at all") — PROP-01 is strictly the MIXED
  // `anyPass && !allPass` case, so the two never double-diagnose the same rule.
  // Needs `--base` AND `--results`. Computed at check time as a post-`runIndex`
  // projection, never perturbs `build_id` (GATE-04). Reuses the Diagnostic
  // interface unchanged.
  PARTIAL_PROPAGATION: "PARTIAL_PROPAGATION",
  // TERM-04 (Phase 6, dogfooded in CHCK): a `cites` entry on a requirement
  // resolves to NO term — `term_citations.term_id IS NULL` (an unresolvable
  // citation still lands per Invariant #4, so the diagnostic has something to
  // fire on). This IS the §4.10 payoff ("a term left to interpretation, now
  // caught"): a requirement pointing at a word no glossary defines. ERROR
  // severity, mirroring DANGLING_TAG (a tag pointing at a non-existent req) —
  // it flips `spec check --ci` to exit 1 via the unchanged
  // `severity === "error"` predicate. Computed by Q8 in sqlite.ts (a LEFT JOIN
  // over term_citations, the BROKEN_RELATES shape); repo:null, keyed on the
  // citing req_id (the defect is in the SPEC's cites field, not a member repo).
  // @spec CHCK-004
  UNDEFINED_TERM: "UNDEFINED_TERM",
  // TERM-04 (Phase 6, dogfooded in CHCK): an Active TERM entry that NO
  // requirement cites (zero inbound `term_citations` rows) — glossary rot, a
  // defined-but-unused term. WARNING severity, and it MUST stay warning: a
  // freshly-migrated or newly-minted term legitimately has no citations yet,
  // and Wave F migrates ~30 GLOSSARY.md terms AT ONCE — an error would red the
  // gate the instant the glossary lands (RESEARCH Pitfall 4). Composes with the
  // `severity === "error"` predicate so an orphan-term-only platform still
  // exits 0. Computed by Q9 in sqlite.ts (the ORPHAN_REQ NOT-EXISTS shape,
  // scoped to key='TERM' AND status='Active'); repo:null, keyed on the term id.
  // @spec CHCK-004
  ORPHAN_TERM: "ORPHAN_TERM",
  // TERM-05 (Phase 6, dogfooded in CHCK): a requirement whose `cites` pin LAGS
  // the cited term's current version — the citation was confirmed against an
  // older definition, and an in-place `spec term revise` version-bump moved the
  // term on. This is the member-pin DRIFT model replayed ONE LEVEL UP
  // (req -> term): the `term_drift` VIEW (schema.ts) owns the predicate
  // `term.changed_at_version > citation.pinned`, a 1:1 shape-clone of the
  // member-pin `drift` VIEW (CHCK-03: one predicate, one place). WARNING
  // severity — and it MUST stay warning, mirroring the soft coverage drift: a
  // lagging pin is a re-confirmation prompt (run `spec term confirm`), NOT a
  // build-breaking defect, so a drifted citation keeps `spec check --ci` at
  // exit 0. Computed by Q10 (a SELECT over term_drift); repo:null, keyed on the
  // citing req_id. @spec CHCK-005
  TERM_DRIFT: "TERM_DRIFT",
  // TERM-05 (Phase 6, dogfooded in CHCK): a requirement citing a SUPERSEDED term
  // id — after `spec supersede TERM-NNN` minted a successor, the citation still
  // points at the old id. The exact analogue of SUPERSEDED_REFERENCED (a code
  // tag on a superseded requirement), one level up: a citation is a "tag" from a
  // requirement onto a term. ERROR severity (like SUPERSEDED_REFERENCED), so it
  // flips `spec check --ci` to exit 1 via the unchanged `severity === 'error'`
  // predicate — a spec must not ship citing a retired definition; re-point it
  // with `spec term confirm`. Computed by Q11 (term_citations JOIN the cited
  // term WHERE status='Superseded', the Q2 clone); repo:null, keyed on the
  // citing req_id. @spec CHCK-005
  SUPERSEDED_TERM_REFERENCED: "SUPERSEDED_TERM_REFERENCED",
} as const;

export type DiagnosticCode = (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

export interface Diagnostic {
  code: DiagnosticCode;
  source_file: string | null;
  line: number | null;
  repo: string | null;
  req_id: string | null;
  detail: string;
  severity: "error" | "warning";
}

/**
 * Thrown by `discoverRepos` when the resolved platform directory has no
 * canonical `spec-engine/` subdirectory — i.e. the path is not a Spec Engine
 * platform yet. A typed sentinel (not a string-matched plain Error) so the
 * `map` / `index` / `check` command boundaries can branch on the
 * missing-canonical case via `instanceof` and print a friendly,
 * actionable message instead of leaking a raw Bun stack trace.
 *
 * Only the missing-canonical-directory case throws this; every other
 * discovery failure (malformed config, Zod validation, mid-read I/O) still
 * throws a plain Error and propagates unchanged.
 */
export class NotASpecPlatformError extends Error {
  /** The resolved absolute platform directory that lacked `spec-engine/`. */
  public readonly platformDir: string;

  constructor(platformDir: string) {
    super(`Not a Spec Engine platform: no 'spec-engine/' directory under ${platformDir}`);
    this.name = "NotASpecPlatformError";
    this.platformDir = platformDir;
    // Preserve the prototype chain so `instanceof` works after transpilation
    // to ES5-ish targets (defensive; Bun targets ES2022 but this is cheap).
    Object.setPrototypeOf(this, NotASpecPlatformError.prototype);
  }
}
