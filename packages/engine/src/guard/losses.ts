// packages/engine/src/guard/losses.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec GUARD-002
// @spec GUARD-003
// @spec GUARD-004
// @spec GUARD-005
// @spec GUARD-006
//
// The pure loss classifier at the heart of `spec guard`. Given
// the requirement derivation at a git ref (the "base") and a set of already-
// computed working-tree facts, it returns the requirements about to be lost.
//
// Mirrors the pure-detector pattern of check/removed.ts and check/statusflip.ts:
// data in, `Loss[]` out — no Storage, no git, no filesystem, no bun:sqlite
// (D-08 fence). All git/DB/FS gathering lives in guard/collect.ts; this module
// only decides. Keeping it pure is what makes the whole loss taxonomy unit-
// testable without a git repo.
//
// The four loss classes:
//   REQUIREMENT_REMOVED       — a req Active at the ref is absent from the working-tree
//                       spec with no approved supersession (GUARD-002).
//   IMPL_LOST         — the LAST implementing tag for a surviving Active req is
//                       gone from the whole working tree (GUARD-003).
//   VERIFY_LOST       — the LAST verifying tag for a surviving Active req is
//                       gone from the whole working tree (GUARD-004).
//   SPEC_FILE_DELETED — a canonical spec file present at the ref is gone
//                       (GUARD-005).
//
// Two suppressions (a loss is NOT a loss when):
//   - the requirement was properly superseded in the same change — in either
//     direction (GUARD-006), OR
//   - the change carries an `@spec approve KEY-NNN <reason>` directive
//     (GUARD-007, the escape hatch — `approved` is populated by the caller from
//     guard/directives.ts).

import type { SpecRequirement } from "@spec-engine/shared";

export type LossKind = "REQUIREMENT_REMOVED" | "IMPL_LOST" | "VERIFY_LOST" | "SPEC_FILE_DELETED";

/** A tag site at the base ref: the platform-relative file and 1-based line the
 *  now-removed `@spec` tag sat on. Feeds the block message's "(src/x.ts:12)". */
export interface TagSite {
  file: string;
  line: number;
}

/** One requirement about to be lost. `req_id` is null only for
 *  SPEC_FILE_DELETED (a file-level, not requirement-level, loss). `line` is 0
 *  when the loss has no meaningful source line (REQUIREMENT_REMOVED / SPEC_FILE_DELETED).
 *  `detail` is the chrome-free machine sentence the --json row carries; the
 *  human product-surface block message is composed separately in format.ts. */
export interface Loss {
  kind: LossKind;
  req_id: string | null;
  file: string;
  line: number;
  detail: string;
}

/**
 * The already-computed facts the classifier decides over. Every field is plain
 * data (Maps/Sets/arrays), deliberately NOT git/Storage handles, so this stays
 * pure and unit-testable. guard/collect.ts builds this from the base ref (git)
 * and the working tree (parser + the derived index via the Storage seam).
 */
export interface GuardFacts {
  /** Requirements present at the ref, sourced from the SPEC.json files in the
   *  change scope. Only Active-at-ref reqs are guarded. */
  baseReqs: readonly SpecRequirement[];
  /** id → platform-relative base spec path (for the REQUIREMENT_REMOVED row's file). */
  baseReqPath: ReadonlyMap<string, string>;
  /** id → a base implementing-tag site among changed files (first site wins).
   *  Presence of a key means "had ≥1 implementing tag at the ref". */
  baseImplSite: ReadonlyMap<string, TagSite>;
  /** id → a base verifying-tag site among changed files (first site wins). */
  baseVerifySite: ReadonlyMap<string, TagSite>;
  /** Every requirement id present in the working-tree spec. */
  worktreeReqIds: ReadonlySet<string>;
  /** Working-tree requirement ids whose status is Active. */
  worktreeActiveIds: ReadonlySet<string>;
  /** Ids some surviving working-tree requirement declares `supersedes` on. */
  worktreeSupersedesTargets: ReadonlySet<string>;
  /** id → count of implementing tags across the WHOLE working tree (the
   *  derived index). Zero (absent key) means "no implementation survives". */
  worktreeImplCount: ReadonlyMap<string, number>;
  /** id → count of verifying tags across the WHOLE working tree. */
  worktreeVerifyCount: ReadonlyMap<string, number>;
  /** Requirement ids acknowledged by an `@spec approve` directive in the
   *  change — every loss for these is suppressed (GUARD-007). */
  approved: ReadonlySet<string>;
  /** Canonical spec files present at the ref but absent from the working tree
   *  (git status `D` under spec-engine) — one SPEC_FILE_DELETED each. */
  deletedSpecFiles: readonly string[];
}

/** A status string (raw lowercase authored JSON) is Active. */
function isActive(status: string): boolean {
  return status.toLowerCase() === "active";
}

/** GUARD-006: a base req absent from the change is exempt when the sanctioned
 *  supersede path was followed — in EITHER direction: the base req points
 *  forward to a successor that survives, OR a surviving req points back at it
 *  via `supersedes`. Mirrors check/removed.ts's exemption exactly. */
function isSuperseded(base: SpecRequirement, f: GuardFacts): boolean {
  const forward = base.supersededBy != null && f.worktreeReqIds.has(base.supersededBy);
  return forward || f.worktreeSupersedesTargets.has(base.id);
}

function reqDeletedLoss(base: SpecRequirement, f: GuardFacts): Loss {
  return {
    kind: "REQUIREMENT_REMOVED",
    req_id: base.id,
    file: f.baseReqPath.get(base.id) ?? "",
    line: 0,
    detail: `${base.id} was Active at the ref but is absent from the working-tree spec with no approved supersession`,
  };
}

function implLostLoss(id: string, site: TagSite): Loss {
  return {
    kind: "IMPL_LOST",
    req_id: id,
    file: site.file,
    line: site.line,
    detail: `${id} lost its last implementing @spec tag (was ${site.file}:${site.line})`,
  };
}

function verifyLostLoss(id: string, site: TagSite): Loss {
  return {
    kind: "VERIFY_LOST",
    req_id: id,
    file: site.file,
    line: site.line,
    detail: `${id} lost its last verifying @spec tag (was ${site.file}:${site.line})`,
  };
}

function specFileDeletedLoss(path: string): Loss {
  return {
    kind: "SPEC_FILE_DELETED",
    req_id: null,
    file: path,
    line: 0,
    detail: `canonical spec file ${path} present at the ref is absent from the working tree`,
  };
}

/**
 * REQUIREMENT_REMOVED for one base requirement (from a changed spec file), or null. A
 * requirement is lost when it was Active at the ref, is absent from the working
 * tree, and was neither approved (GUARD-007) nor properly superseded in either
 * direction (GUARD-006). A requirement that SURVIVES in the working tree is not
 * a REQUIREMENT_REMOVED — any tag loss it suffers is caught by the tag-driven pass.
 */
function reqDeletedFor(base: SpecRequirement, f: GuardFacts): Loss | null {
  if (!isActive(base.status)) return null;
  if (f.approved.has(base.id)) return null;
  if (f.worktreeReqIds.has(base.id)) return null;
  if (isSuperseded(base, f)) return null;
  return reqDeletedLoss(base, f);
}

/** True iff `id` — which had a base tag of the relevant kind in a changed code
 *  file — has lost its LAST tag of that kind. Gated on the working tree: only a
 *  surviving, still-Active, un-approved requirement is guarded. A req that was
 *  deleted (REQUIREMENT_REMOVED owns it), superseded (status flipped OUT of Active — the
 *  expected retag worklist, GUARD-006), or approved (GUARD-007) is excluded by
 *  the same `worktreeActiveIds`/`approved` gate. `count === 0` means no tag of
 *  that kind survives anywhere in the working tree (the derived index). */
function lastTagGone(id: string, count: number, f: GuardFacts): boolean {
  return !f.approved.has(id) && f.worktreeActiveIds.has(id) && count === 0;
}

/**
 * Classify every requirement loss the change is about to commit. Pure: never
 * mutates its input, does no I/O, and does NOT sort — format.ts owns the
 * deterministic ordering (mirroring the check/format.ts split).
 *
 * Two independent drivers, because a loss can originate on either side of the
 * change:
 *   - the SPEC side (changed SPEC.json → `baseReqs`) drives REQUIREMENT_REMOVED
 *     (GUARD-002), and
 *   - the CODE side (changed source → `baseImplSite` / `baseVerifySite`) drives
 *     IMPL_LOST / VERIFY_LOST (GUARD-003/004) — these fire on a code-only change
 *     that never touches the spec, which is exactly the silent gutting the guard
 *     exists to catch.
 * Then one SPEC_FILE_DELETED per deleted canonical spec file (GUARD-005).
 */
export function classifyLosses(f: GuardFacts): Loss[] {
  const out: Loss[] = [];

  for (const base of f.baseReqs) {
    const loss = reqDeletedFor(base, f);
    if (loss !== null) out.push(loss);
  }

  for (const [id, site] of f.baseImplSite) {
    if (lastTagGone(id, f.worktreeImplCount.get(id) ?? 0, f)) out.push(implLostLoss(id, site));
  }
  for (const [id, site] of f.baseVerifySite) {
    if (lastTagGone(id, f.worktreeVerifyCount.get(id) ?? 0, f)) out.push(verifyLostLoss(id, site));
  }

  for (const path of f.deletedSpecFiles) out.push(specFileDeletedLoss(path));
  return out;
}
