// packages/webapp/src/pages/coverage.ts
//
// Plan 05-04 / Task 1 — SSR coverage matrix page (`GET /`). This is the
// CANONICAL coverage component from the brand kit's Spec Check Dashboard: a
// domain-grouped matrix where each cell is a per-repo glyph encoding the
// requirement's bind state in that repo (src+test / src only / test only /
// none) and a ROLLUP column reads implemented / verified across repos.
//
// D-09 / WORK-04 / Invariant #5: webapp source imports ONLY from
// `@spec-engine/shared` (types) and `hono` (runtime). NO `bun:sqlite`, no
// `node:fs`, no `fs`, no `bun`, no `node:path`, no `@spec-engine/spec-check`.
// Enforced by `packages/webapp/biome.json`'s `noRestrictedImports` rule
// AND by the defense-in-depth grep test in
// `packages/webapp/test/import-fence.test.ts`.
//
// Rendering shape (RESEARCH § Webapp SSR + plan 05-04 acceptance):
//   - Every handler renders a single self-contained `<!doctype html>`
//     document via ONE `hono/html` tagged template — no shared layout
//     partial, no title/body placeholder substitution, no string-replace
//     on embedded HTML.
//   - Every interpolation auto-escapes via the `hono/html` tagged
//     template (Pitfall 7). The `raw` helper is used ONLY to embed the
//     static `styles.css` asset (origin: source file, never request data).
//
// Data fetch (Pitfall 6): the handler reads `/api/coverage` (and
// `/api/requirements` for row titles) via Hono's in-process
// `app.request(path)` — never `fetch("http://...")`. The caller passes the
// same Hono app that has `mountApi(app, storage)` already wired (plan 05-03),
// so the API and SSR planes share one engine boundary.

import type { CoverageRow, ReportDomainRow, Requirement } from "@spec-engine/shared";
import type { Hono } from "hono";
import { html, raw } from "hono/html";
import { coverageGlyph, heatCell, requirementStatusBadge, specId } from "./components";
import { apiJson, CANONICAL_REPO_NAME } from "./data";
import { healthPcts, reportTotals } from "./health";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

/** Embedded style tag — only call site of `raw` in this module; safe
 *  because `styleSheet` originates from a source file at build time,
 *  never from request data (Pitfall 7). */
const styleTag = raw(`<style>${styleSheet}</style>`);

/** A chevron that rotates open via `.domain-group:not(.collapsed)` (CSS-only).
 *  Own class (not the requirements page's `.domain-chevron`) so the two pages'
 *  rotation rules never cross specificity. */
const chevron = raw(
  '<svg class="matrix-chevron" width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 3 L11 8 L5 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
);

/** Progressive enhancement: click a domain header row to collapse/expand its
 *  requirement rows; Expand/Collapse-all toggle every group at once. No-JS
 *  degrades to every group expanded (the server-rendered default). The typed
 *  `type="module"` form is the sanctioned escalation — the XSS guard forbids
 *  only a BARE `<script>` (see requirements.ts / relations.ts for the pattern). */
const enhanceScript = raw(`<script type="module">
      const groups = () => document.querySelectorAll("tbody.domain-group");
      const setAll = (collapsed) => groups().forEach((g) => g.classList.toggle("collapsed", collapsed));
      const expand = document.querySelector(".expand-all");
      const collapse = document.querySelector(".collapse-all");
      if (expand) expand.addEventListener("click", () => setAll(false));
      if (collapse) collapse.addEventListener("click", () => setAll(true));
      document.querySelectorAll("tr.domain-row").forEach((row) => {
        row.addEventListener("click", () => {
          const group = row.closest("tbody.domain-group");
          if (group) group.classList.toggle("collapsed");
        });
      });
    </script>`);

/** One requirement's row in the pivoted matrix: its status, title, and a
 *  per-repo bind-state map. */
interface MatrixReq {
  id: string;
  status: Requirement["status"];
  cells: Map<string, { impl: 0 | 1; verif: 0 | 1 }>;
}

/**
 * Pivot the flat `(req, repo)` coverage rows into domain → requirement →
 * per-repo cells, plus the stable sorted repo column order. Pure: rows in,
 * a plain nested structure out (no I/O, no request access).
 */
function pivot(rows: CoverageRow[]): {
  repos: string[];
  domains: { key: string; reqs: MatrixReq[] }[];
} {
  const repos = [...new Set(rows.map((r) => r.repo))].sort();
  const byDomain = new Map<string, Map<string, MatrixReq>>();
  for (const row of rows) {
    let dom = byDomain.get(row.domain_key);
    if (!dom) {
      dom = new Map();
      byDomain.set(row.domain_key, dom);
    }
    let req = dom.get(row.req_id);
    if (!req) {
      req = { id: row.req_id, status: row.req_status, cells: new Map() };
      dom.set(row.req_id, req);
    }
    req.cells.set(row.repo, { impl: row.implemented, verif: row.verified });
  }
  const domains = [...byDomain.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, reqMap]) => ({
      key,
      reqs: [...reqMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    }));
  return { repos, domains };
}

/** Mount the coverage page (`GET /`) onto an existing Hono app. */
export function mountCoverage(app: Hono): void {
  app.get("/", async (c) => {
    // The canonical spec store is never tag-scanned, so its column would be
    // structurally all-empty — members only (mirrors the Setup page).
    const rows = (await apiJson<CoverageRow[]>(app, "/api/coverage")).filter(
      (r) => r.repo !== CANONICAL_REPO_NAME,
    );
    // Titles come from the requirement ledger (coverage rows carry no text).
    const reqs = await apiJson<Requirement[]>(app, "/api/requirements");
    const titleOf = new Map(reqs.map((r) => [r.id, r.text]));

    // RED-99 — @spec SERV-005: the default view is the LIVE contract — Superseded/
    // Retired rows (and any domain they empty out) hide unless ?all=1. The
    // toggle is a plain link so the filter is SSR-honest and no-JS-safe.
    const showAll = c.req.query("all") === "1";
    const visible = showAll
      ? rows
      : rows.filter((r) => r.req_status !== "Superseded" && r.req_status !== "Retired");
    const hiddenCount = new Set(
      rows
        .filter((r) => r.req_status === "Superseded" || r.req_status === "Retired")
        .map((r) => r.req_id),
    ).size;

    const { repos, domains } = pivot(visible);
    const reqCount = domains.reduce((n, d) => n + d.reqs.length, 0);
    // Platform-health headline: the /api/report rollup + health math
    // (pages/health.ts) — Active reqs only, same numbers the API and MCP
    // report tools serve.
    const reportRows = await apiJson<ReportDomainRow[]>(app, "/api/report");
    const { implPct, verifPct, verifyGap } = healthPcts(reportTotals(reportRows));

    const body = html`
      ${navBar("coverage")}
      <div class="eyebrow">/ Coverage matrix</div>
      <h1>Coverage matrix</h1>
      <p class="lede">
        Every requirement, every member — who implemented it in source, who verified it with
        tests, and where it's missing, resolved across the whole platform. A member is a repo
        (or, in a monorepo, a package) that pins a spec-engine version.
      </p>

      <div class="stats">
        <div class="stat"><div class="num accent">${reqCount}</div><div class="label">Requirements</div></div>
        <div class="stat"><div class="num">${repos.length}</div><div class="label">Members</div></div>
        <div class="stat"><div class="num">${implPct}%</div><div class="label">Implemented</div></div>
        <div class="stat"><div class="num">${verifPct}%</div><div class="label">Verified</div></div>
        <div class="stat"><div class="num">${verifyGap}%</div><div class="label">Verify gap</div></div>
      </div>

      <div class="matrix-legend">
        <span class="legend-item">${coverageGlyph(1, 1)}src + test</span>
        <span class="legend-item">${coverageGlyph(1, 0)}src only</span>
        <span class="legend-item">${coverageGlyph(0, 1)}test only</span>
        <span class="legend-item">${coverageGlyph(0, 0)}none</span>
        <span class="legend-sep"></span>
        <span class="legend-item">${requirementStatusBadge("Active")}</span>
        ${
          showAll
            ? html`<span class="legend-item">${requirementStatusBadge("Superseded")}</span>
        <span class="legend-item">${requirementStatusBadge("Retired")}</span>`
            : ""
        }
        <span class="panel-spacer"></span>
        <span class="req-controls">
          ${
            showAll
              ? html`<a class="req-btn status-toggle" href="/">Hide superseded &amp; retired</a>`
              : html`<a class="req-btn status-toggle" href="/?all=1">Show superseded &amp; retired${hiddenCount > 0 ? html` (${hiddenCount})` : ""}</a>`
          }
          <button type="button" class="req-btn expand-all">Expand all</button>
          <button type="button" class="req-btn collapse-all">Collapse all</button>
        </span>
      </div>

      <div class="matrix-wrap">
        <table class="matrix">
          <thead>
            <tr>
              <th class="req-col">Requirement</th>
              ${repos.map((r) => html`<th class="repo-col">${r}</th>`)}
              <th class="rollup-col">Rollup</th>
            </tr>
          </thead>
          ${domains.map((dom) => {
            // Rollups sum Active reqs only — Superseded/Retired are null reqs.
            const activeReqs = dom.reqs.filter((req) => req.status === "Active");
            const domImpl = activeReqs.reduce(
              (n, req) => n + [...req.cells.values()].filter((c) => c.impl).length,
              0,
            );
            const domVerif = activeReqs.reduce(
              (n, req) => n + [...req.cells.values()].filter((c) => c.verif).length,
              0,
            );
            return html`
              <tbody class="domain-group">
                <tr class="domain-row">
                  <td class="req-col">
                    <span class="req-cell">
                      ${chevron}
                      <span class="domain-key">${dom.key}</span>
                      <span class="domain-meta">${dom.reqs.length} ${dom.reqs.length === 1 ? "requirement" : "requirements"}</span>
                    </span>
                  </td>
                  ${repos.map((repo) =>
                    // The absorbed /report heatmap: per member, how many of
                    // this domain's active reqs it implements, tinted by the
                    // share of the domain covered. Collapse the groups and
                    // the matrix reads as the platform-health heat grid.
                    heatCell(
                      activeReqs.filter((req) => req.cells.get(repo)?.impl).length,
                      activeReqs.length,
                    ),
                  )}
                  <td class="rollup-col">
                    <span class="domain-rollup" title="implemented / verified across members (active reqs only)">
                      <span class="rollup-impl">${domImpl}</span><span class="rollup-slash">/</span><span class="rollup-verif">${domVerif}</span>
                    </span>
                  </td>
                </tr>
                ${dom.reqs.map((req) => {
                  const isActive = req.status === "Active";
                  const implN = [...req.cells.values()].filter((c) => c.impl).length;
                  const verN = [...req.cells.values()].filter((c) => c.verif).length;
                  return html`
                    <tr class="${req.status === "Superseded" ? "req-row superseded" : "req-row"}">
                      <td class="req-col">
                        <span class="req-cell">
                          ${requirementStatusBadge(req.status)}
                          ${specId(req.id)}
                          <span class="req-title">${titleOf.get(req.id) ?? ""}</span>
                        </span>
                      </td>
                      ${repos.map((repo) => {
                        const cell = req.cells.get(repo);
                        return html`<td class="matrix-cell">${coverageGlyph(cell?.impl ?? 0, cell?.verif ?? 0)}</td>`;
                      })}
                      <td class="rollup-col">
                        ${
                          isActive
                            ? html`<span class="rollup-impl">${implN}</span><span class="rollup-slash">/</span><span class="rollup-verif">${verN}</span>`
                            : html`<span class="rollup-null" title="null req — coverage no longer tracked">—</span>`
                        }
                      </td>
                    </tr>
                  `;
                })}
              </tbody>
            `;
          })}
        </table>
      </div>
      <p class="totals">
        Rollup reads <span class="rollup-impl">implemented</span> / <span class="rollup-verif">verified</span>
        across ${repos.length} members, counting active requirements only.
        ${
          showAll
            ? html`Dimmed rows are superseded requirement versions (null reqs — excluded from every rollup).`
            : html`Superseded and retired requirements are hidden — the matrix shows the live contract.`
        }
      </p>
    `;

    return c.html(html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>spec-check — Coverage</title>
    ${styleTag}
  </head>
  <body>
    ${body} ${enhanceScript}
  </body>
</html>`);
  });
}
