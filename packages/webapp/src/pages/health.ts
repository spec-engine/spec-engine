// packages/webapp/src/pages/health.ts
//
// The platform-health headline math — totals over the /api/report per-domain
// rollup rows, and the Impl% / Verif% / verify-gap percentages derived from
// them. Originally extracted from the retired /report page; the Coverage
// stats row is the surviving renderer, and /api/report (+ the MCP
// spec_coverage_report tool) keeps serving the same rollup.
//
// D-09 / Invariant #5: type-only import from @spec-engine/shared; pure
// functions, no I/O, no request access.

import type { ReportDomainRow } from "@spec-engine/shared";

/** Platform-wide sums of the per-domain rollup rows (Active reqs only —
 *  /api/report is Active-only by construction). */
export interface HealthTotals {
  active: number;
  implemented: number;
  verified: number;
  orphans: number;
  unverified: number;
}

/** Sum the per-domain rollup into platform totals. */
export function reportTotals(rows: ReportDomainRow[]): HealthTotals {
  return rows.reduce(
    (t, r) => ({
      active: t.active + r.active,
      implemented: t.implemented + r.implemented,
      verified: t.verified + r.verified,
      orphans: t.orphans + r.orphans,
      unverified: t.unverified + r.unverified,
    }),
    { active: 0, implemented: 0, verified: 0, orphans: 0, unverified: 0 },
  );
}

/** Integer percentage, 0 when the denominator is 0. */
export function pctNum(num: number, den: number): number {
  return den === 0 ? 0 : Math.round((num / den) * 100);
}

/** The three headline numbers. Verify gap = implemented-but-not-yet-verified
 *  share, clamped at 0: when a platform has more verified than implemented
 *  bindings (test-only bindings — a passing test with no source tag), there
 *  is no verification backlog. */
export function healthPcts(t: HealthTotals): {
  implPct: number;
  verifPct: number;
  verifyGap: number;
} {
  const implPct = pctNum(t.implemented, t.active);
  const verifPct = pctNum(t.verified, t.active);
  return { implPct, verifPct, verifyGap: Math.max(0, implPct - verifPct) };
}
