// packages/shared/src/report.ts
//
// W1 (webapp coverage report) — pure rollup from the (req × repo) coverage
// matrix to one row per domain over ACTIVE requirements. Lives in shared so
// the engine API (/api/report), the webapp page, and any future CLI report
// command compute the numbers from ONE function (one engine, not two).
//
// Coverage semantics mirror the check diagnostics' vocabulary:
//   implemented — an implementing tag in ANY repo (ORPHAN_REQ's inverse)
//   verified    — a verifying tag in ANY repo (UNVERIFIED_REQ's inverse)
//   orphans     — Active reqs with no implementing tag anywhere
//   unverified  — implemented but not verified
//
// Purity: no I/O, no bun:sqlite (D-11 fence) — input is the CoverageRow[]
// shape the coverage VIEW already serves.

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
 * Roll the coverage matrix up into one row per domain, lexicographically
 * sorted. Non-Active requirements are excluded from every count — the
 * report answers "how covered is the standing truth", and superseded /
 * retired entries are history, not obligations.
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
