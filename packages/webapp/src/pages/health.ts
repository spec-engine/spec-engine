import type { ReportDomainRow } from "@spec-engine/shared";

/** Active requirements only: /api/report rows are Active-only. */
export interface HealthTotals {
  active: number;
  implemented: number;
  verified: number;
  orphans: number;
  unverified: number;
}

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

export function pctNum(num: number, den: number): number {
  return den === 0 ? 0 : Math.round((num / den) * 100);
}

/** The verify gap is clamped at 0: test-only bindings (a passing test with no
 *  source tag) can make verified exceed implemented, and that is no backlog. */
export function healthPcts(t: HealthTotals): {
  implPct: number;
  verifPct: number;
  verifyGap: number;
} {
  const implPct = pctNum(t.implemented, t.active);
  const verifPct = pctNum(t.verified, t.active);
  return { implPct, verifPct, verifyGap: Math.max(0, implPct - verifPct) };
}
