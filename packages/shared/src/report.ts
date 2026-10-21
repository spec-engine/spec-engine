// In shared so /api/report and the webapp page compute the numbers from one
// function.

import type { CoverageRow } from "./storage";

export interface ReportDomainRow {
  domain: string;
  /** Count of Active requirements in the domain. */
  active: number;
  /** Active requirements with an implementing tag in any repo. */
  implemented: number;
  /** Active requirements with a verifying tag in any repo. */
  verified: number;
  /** Active requirements with no implementing tag anywhere. */
  orphans: number;
  /** Implemented but not verified. */
  unverified: number;
}

/**
 * Non-Active requirements are excluded from every count: superseded and
 * retired entries are history, not obligations.
 * @spec CHCK-032
 */
export function buildCoverageReport(rows: CoverageRow[]): ReportDomainRow[] {
  // Collapse (req × repo) to per-requirement any-repo flags first.
  const perReq = new Map<string, { domain: string; implemented: boolean; verified: boolean }>();
  for (const r of rows) {
    if (r.req_status !== "Active") continue;
    const cur = perReq.get(r.req_id) ?? {
      domain: r.domain_key,
      implemented: false,
      verified: false,
    };
    cur.implemented ||= r.implemented === 1;
    cur.verified ||= r.verified === 1;
    perReq.set(r.req_id, cur);
  }

  const byDomain = new Map<string, ReportDomainRow>();
  for (const { domain, implemented, verified } of perReq.values()) {
    const row = byDomain.get(domain) ?? {
      domain,
      active: 0,
      implemented: 0,
      verified: 0,
      orphans: 0,
      unverified: 0,
    };
    row.active += 1;
    if (implemented) row.implemented += 1;
    if (verified) row.verified += 1;
    if (!implemented) row.orphans += 1;
    if (implemented && !verified) row.unverified += 1;
    byDomain.set(domain, row);
  }

  return [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}
