// packages/webapp/src/pages/requirements.ts
//
// Plan 05-04 / Task 1 — SSR requirement browser (`GET /requirements`
// list + `GET /requirements/:id` detail).
//
// D-09 / WORK-04 / Invariant #5: webapp source imports ONLY from
// `@spec-engine/shared` (types) and `hono` (runtime). NO `bun:sqlite`, no
// `node:fs`, no `fs`, no `bun`, no `node:path`, no `@spec-engine/spec-engine`.
//
// Rendering shape — each handler is a single self-contained
// `<!doctype html>` document via ONE `hono/html` tagged template
// (Pitfall 7 auto-escape). The `raw` helper is used ONLY for the
// static styles.css asset (see coverage.ts header for the contract).
//
// Data fetch — in-process via `app.request(path)` (Pitfall 6, NEVER
// `fetch("http://...")`).

import type { CoverageRow, Requirement } from "@spec-engine/shared";
import type { Hono } from "hono";
import { html, raw } from "hono/html";
import { requirementStatusBadge, specId } from "./components";
import { apiJson, toApiError } from "./data";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

const styleTag = raw(`<style>${styleSheet}</style>`);

/** One tag site for a requirement — the row shape `/api/resolve?req=` returns
 *  (the engine's `ReqTagRow`, a `Tag` minus its AUTOINCREMENT id). Redeclared
 *  here because the import fence forbids reaching into `@spec-engine/spec-engine`. */
interface ReqTagRow {
  req_id: string;
  repo: string;
  file: string;
  line: number;
  kind: string;
  level: string | null;
}

/** Per-requirement view model backing one accordion row + its detail panel. */
interface PanelReq {
  req: Requirement;
  impl: number; // repos implementing (src or src+test)
  verif: number; // repos verifying (src+test)
  chain: Requirement[]; // supersession lineage, most-recent-first; length 1 = standalone
  tags: ReqTagRow[]; // bound files (tag sites)
}

/** The short kind tag shown against each bound file. */
const KIND_LABEL: Record<string, string> = {
  implements: "impl",
  verifies: "test",
  documents: "doc",
};

/** One domain's accordion card + its requirements' view models. */
interface DomainGroup {
  key: string;
  reqs: PanelReq[];
}

/** A chevron that rotates open via `details[open] .domain-chevron` (CSS-only). */
const chevron = raw(
  '<svg class="domain-chevron" width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 3 L11 8 L5 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
);

/** The client-side progressive enhancement: Expand/Collapse-all toggle the
 *  `<details>` cards, and clicking a requirement row reveals its detail panel
 *  in place (no navigation, no fetch, no innerHTML — attribute/class toggles
 *  only). The typed `type="module"` form is the sanctioned escalation (the XSS
 *  guard forbids only a BARE `<script>`; relations.ts ships the same pattern). */
const enhanceScript = raw(`<script type="module">
      const cards = () => document.querySelectorAll("details.domain-card");
      const expand = document.querySelector(".expand-all");
      const collapse = document.querySelector(".collapse-all");
      if (expand) expand.addEventListener("click", () => cards().forEach((d) => (d.open = true)));
      if (collapse) collapse.addEventListener("click", () => cards().forEach((d) => (d.open = false)));

      const select = (id) => {
        if (!id) return;
        document.querySelectorAll(".req-panel").forEach((p) => p.classList.remove("is-open"));
        document.querySelectorAll(".req-item").forEach((a) => a.classList.remove("selected"));
        const panel = document.getElementById("panel-" + id);
        if (panel) panel.classList.add("is-open");
        const item = document.querySelector('.req-item[data-req="' + id + '"]');
        if (item) {
          item.classList.add("selected");
          const card = item.closest("details.domain-card");
          if (card) card.open = true;
        }
      };
      document.querySelectorAll(".req-item").forEach((a) => {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          select(a.getAttribute("data-req"));
        });
      });
    </script>`);

/** Members implementing / verifying, per requirement — the coverage rollup.
 *  Active requirements only: a Superseded/Retired req is a null req whose
 *  coverage no longer matters, so it never contributes to any rollup. */
function coverageRollups(coverage: CoverageRow[]): Map<string, { impl: number; verif: number }> {
  const cov = new Map<string, { impl: number; verif: number }>();
  for (const row of coverage) {
    if (row.req_status !== "Active") continue;
    const c = cov.get(row.req_id) ?? { impl: 0, verif: 0 };
    if (row.implemented) c.impl += 1;
    if (row.verified) c.verif += 1;
    cov.set(row.req_id, c);
  }
  return cov;
}

/** The supersession lineage of one requirement, most-recent-first.
 *  `superseded_by` points OLD → NEW and is resolved GLOBALLY (a cross-domain
 *  move still lands in `byId`): walk back to the root, then forward collecting
 *  the chain. length 1 = standalone (no amendments). */
function lineageOf(
  byId: Map<string, Requirement>,
  predecessorOf: Map<string, string>,
  r: Requirement,
): Requirement[] {
  let rootId = r.id;
  const back = new Set<string>();
  while (predecessorOf.has(rootId) && !back.has(rootId)) {
    back.add(rootId);
    rootId = predecessorOf.get(rootId) as string;
  }
  const chain: Requirement[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = rootId;
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    chain.push(byId.get(cur) as Requirement);
    cur = byId.get(cur)?.superseded_by ?? undefined;
  }
  return chain.reverse();
}

/** Assemble the domain groups (sorted by key, requirements sorted by id — the
 *  same grouping the coverage matrix uses) plus the id of the default-selected
 *  panel (the first requirement of the first domain).
 *
 *  RED-99 — @spec SERV-005: `allReqs` vs `listed` matters — lineage (byId /
 *  predecessorOf) walks the FULL ledger so a visible requirement's version
 *  history keeps its superseded predecessors even while the default filter
 *  hides those predecessors as rows. */
function buildDomains(
  allReqs: Requirement[],
  listed: Requirement[],
  coverage: CoverageRow[],
  tagsById: Map<string, ReqTagRow[]>,
): { domains: DomainGroup[]; defaultId: string } {
  const cov = coverageRollups(coverage);
  const byId = new Map(allReqs.map((r) => [r.id, r]));
  const predecessorOf = new Map<string, string>();
  for (const r of allReqs) if (r.superseded_by) predecessorOf.set(r.superseded_by, r.id);

  const byKey = new Map<string, PanelReq[]>();
  for (const req of listed) {
    const c = cov.get(req.id) ?? { impl: 0, verif: 0 };
    const model: PanelReq = {
      req,
      impl: c.impl,
      verif: c.verif,
      chain: lineageOf(byId, predecessorOf, req),
      tags: tagsById.get(req.id) ?? [],
    };
    const list = byKey.get(req.key);
    if (list) list.push(model);
    else byKey.set(req.key, [model]);
  }
  const domains = [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => ({
      key,
      reqs: list.sort((a, b) => a.req.id.localeCompare(b.req.id)),
    }));
  return { domains, defaultId: domains[0]?.reqs[0]?.req.id ?? "" };
}

/** The `v{n}` pill — accent-styled when the requirement is part of a lineage.
 *  `spec_version` is the DOMAIN envelope's current version (shared by every req
 *  in the domain), hence the title — it is NOT a per-requirement revision count. */
function verPill(r: Requirement, versioned: boolean): ReturnType<typeof html> {
  return html`<span class="ver-pill ${versioned ? "versioned" : ""}" title="domain spec version (envelope)">v${r.spec_version}</span>`;
}

/** The lifecycle-meaningful version label for one lineage node. A superseded /
 *  retired entry shows the envelope version it DIED at (`superseded_at_version`,
 *  authored once at the supersession); one superseded before that field existed
 *  shows no number (the historical value is unrecoverable — no back-fill). A live
 *  entry shows "current". Deliberately NOT `spec_version`, which is the domain
 *  envelope's CURRENT version — identical for every req in the domain and the
 *  source of the "why does this jump 10 → 23?" confusion. */
function chainVerLabel(v: Requirement): ReturnType<typeof html> {
  const dead = v.status === "Superseded" || v.status === "Retired";
  if (dead && v.superseded_at_version != null) {
    return html`<span class="chain-ver">superseded at v${v.superseded_at_version}</span>`;
  }
  if (dead) {
    return html`<span class="chain-ver muted" title="superseded before the version was recorded">version not recorded</span>`;
  }
  return html`<span class="chain-ver current-ver">current</span>`;
}

/** The version-history disclosure: the real lineage timeline, or the single
 *  "no amendments" line for a standalone requirement. */
function renderLineage(m: PanelReq): ReturnType<typeof html> {
  if (m.chain.length <= 1) {
    return html`<div class="single-version">
      <span class="chain-dot"></span>
      <span>No amendments — this is the only version.</span>
    </div>`;
  }
  return html`<div class="version-chain">
    ${m.chain.map(
      (v) => html`
        <div class="chain-node ${v.id === m.req.id ? "current" : ""}">
          <span class="chain-dot"></span>
          <div class="chain-meta">
            ${specId(v.id)} ${requirementStatusBadge(v.status)}
            ${chainVerLabel(v)}
          </div>
        </div>
      `,
    )}
  </div>`;
}

/** The bound-files (tag sites) list, or a "no code binds yet" note. */
function renderBoundFiles(tags: ReqTagRow[]): ReturnType<typeof html> {
  if (tags.length === 0) {
    return html`<p class="no-files">No code binds to this requirement yet.</p>`;
  }
  return html`<div class="bound-files">
    ${tags.map(
      (t) => html`
        <div class="bound-file">
          <span class="file-tag ${t.kind}">${KIND_LABEL[t.kind] ?? t.kind}</span>
          <span class="file-path">${t.file}</span>
          <span class="file-line">L${t.line}</span>
        </div>
      `,
    )}
  </div>`;
}

/** One requirement's sticky detail panel (server-rendered, hidden unless it is
 *  the default or the client selects it). */
function renderPanel(m: PanelReq, defaultId: string): ReturnType<typeof html> {
  const r = m.req;
  return html`
    <section class="req-panel ${r.id === defaultId ? "is-open" : ""}" id="panel-${r.id}">
      <div class="panel-head">
        <div class="panel-id-row">
          ${specId(r.id)} ${requirementStatusBadge(r.status)}
          <span class="panel-spacer"></span>
          ${verPill(r, m.chain.length > 1)}
        </div>
        <div class="panel-title">${r.text}</div>
      </div>
      <div class="panel-body">
        ${r.why ? html`<p class="panel-why">${r.why}</p>` : ""}
        <div class="section-label">Version history</div>
        ${renderLineage(m)}
        <div class="section-label">Bound files</div>
        ${renderBoundFiles(m.tags)}
      </div>
    </section>
  `;
}

/** One collapsible domain card: summary (chevron · key · count · active/super
 *  segment bar · verified/implemented rollup) + the requirement rows. */
function renderDomainCard(dom: DomainGroup, defaultId: string): ReturnType<typeof html> {
  const active = dom.reqs.filter((m) => m.req.status === "Active").length;
  const sup = dom.reqs.length - active;
  const domImpl = dom.reqs.reduce((n, m) => n + m.impl, 0);
  const domVerif = dom.reqs.reduce((n, m) => n + m.verif, 0);
  const segWidth = (n: number) => Math.min(n, 12) * 8;
  return html`
    <details class="domain-card">
      <summary class="domain-summary">
        ${chevron}
        <span class="domain-key">${dom.key}</span>
        <span class="domain-meta">${dom.reqs.length} reqs</span>
        <span class="panel-spacer"></span>
        <span class="seg-bar" title="${active} active · ${sup} superseded">
          ${active > 0 ? html`<span class="seg active" style="width:${segWidth(active)}px"></span>` : ""}
          ${sup > 0 ? html`<span class="seg sup" style="width:${segWidth(sup)}px"></span>` : ""}
        </span>
        <span class="dom-rollup" title="verified / implemented members (active reqs only)">✓ ${domVerif}/${domImpl}</span>
      </summary>
      <div class="domain-rows">
        ${dom.reqs.map(
          (m) => html`
            <a
              class="req-item ${m.req.id === defaultId ? "selected" : ""}"
              href="/requirements/${encodeURIComponent(m.req.id)}"
              data-req="${m.req.id}"
            >
              ${requirementStatusBadge(m.req.status)} ${specId(m.req.id)}
              <span class="req-item-title">${m.req.text}</span>
              ${verPill(m.req, m.chain.length > 1)}
              ${
                m.req.status === "Active"
                  ? html`<span class="req-item-cov" title="verified / implemented members">${m.verif}/${m.impl}</span>`
                  : html`<span class="req-item-cov rollup-null" title="null req — coverage no longer tracked">—</span>`
              }
            </a>
          `,
        )}
      </div>
    </details>
  `;
}

/** The page body: header + Expand/Collapse-all + accordion / sticky panels, or
 *  a first-requirement guidance note when the platform has none. */
function renderBody(
  domains: DomainGroup[],
  defaultId: string,
  reqTotal: number,
  showAll: boolean,
  hiddenCount: number,
): ReturnType<typeof html> {
  // RED-99 — @spec SERV-005: the toggle is a plain link (SSR-honest, no-JS-safe)
  // between the live-contract default and the full ledger.
  const statusToggle = showAll
    ? html`<a class="req-btn status-toggle" href="/requirements">Hide superseded &amp; retired</a>`
    : html`<a class="req-btn status-toggle" href="/requirements?all=1">Show superseded &amp; retired${hiddenCount > 0 ? html` (${hiddenCount})` : ""}</a>`;
  const header = html`
    <div class="req-header">
      <div>
        <div class="eyebrow">/ Requirements</div>
        <h1>Requirements</h1>
        <p class="lede">
          ${reqTotal} requirements across ${domains.length} domains.${showAll || hiddenCount === 0 ? "" : html` ${hiddenCount} superseded/retired hidden.`}
        </p>
      </div>
      ${
        reqTotal === 0 && hiddenCount === 0
          ? ""
          : html`<div class="req-controls">
              ${statusToggle}
              <button type="button" class="req-btn expand-all">Expand all</button>
              <button type="button" class="req-btn collapse-all">Collapse all</button>
            </div>`
      }
    </div>
  `;
  if (reqTotal === 0) {
    return html`
      ${navBar("requirements")} ${header}
      <p class="lede">
        ${
          hiddenCount > 0
            ? html`Every indexed requirement is superseded or retired — use the toggle above to
        browse the historical ledger.`
            : html`No requirements indexed yet. Author one with
        <code>spec req &lt;domain&gt; --text "…"</code>, then re-run <code>spec index</code>.`
        }
      </p>
    `;
  }
  return html`
    ${navBar("requirements")} ${header}
    <div class="req-layout">
      <div class="req-accordion">${domains.map((dom) => renderDomainCard(dom, defaultId))}</div>
      <aside class="req-aside">
        ${domains.flatMap((dom) => dom.reqs.map((m) => renderPanel(m, defaultId)))}
      </aside>
    </div>
  `;
}

/** Mount both `/requirements` (list) and `/requirements/:id` (detail). */
export function mountRequirements(app: Hono): void {
  app.get("/requirements", async (c) => {
    const reqs = await apiJson<Requirement[]>(app, "/api/requirements");
    const coverage = await apiJson<CoverageRow[]>(app, "/api/coverage");

    // RED-99 — @spec SERV-005: default to the live contract — Superseded/Retired
    // entries (and any domain they empty out) list only under ?all=1. The
    // full ledger still feeds buildDomains so version history stays whole.
    const showAll = c.req.query("all") === "1";
    const listed = showAll
      ? reqs
      : reqs.filter((r) => r.status !== "Superseded" && r.status !== "Retired");
    const hiddenCount = reqs.filter(
      (r) => r.status === "Superseded" || r.status === "Retired",
    ).length;

    // Per-requirement bound files for the LISTED reqs only: reverse-resolve
    // each id in-process (cheap prepared queries; no network — Pitfall 6).
    // Parallel so page latency is one round of the derived index, not N
    // sequential reads.
    const tagLists = await Promise.all(
      listed.map((r) => apiJson<ReqTagRow[]>(app, `/api/resolve?req=${encodeURIComponent(r.id)}`)),
    );
    const tagsById = new Map(listed.map((r, i) => [r.id, tagLists[i] ?? []]));

    const { domains, defaultId } = buildDomains(reqs, listed, coverage, tagsById);

    return c.html(html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Spec Engine — Requirements</title>
    ${styleTag}
  </head>
  <body>
    ${renderBody(domains, defaultId, listed.length, showAll, hiddenCount)} ${enhanceScript}
  </body>
</html>`);
  });

  app.get("/requirements/:id", async (c) => {
    const id = c.req.param("id");
    const res = await app.request(`/api/requirements/${encodeURIComponent(id)}`);

    // Not-ok other than the friendly 404 (storage unavailable, internal
    // error) routes to the app error boundary with the engine's hint.
    if (!res.ok && res.status !== 404) {
      throw await toApiError(res, "/api/requirements/:id");
    }

    if (res.status === 404) {
      const body = html`
        ${navBar("requirements")}
        <div class="eyebrow">/ Requirement</div>
        <h1>Requirement not found</h1>
        <p class="lede">No requirement with id <code>${id}</code> exists in this platform index.</p>
        <p><a href="/requirements">← Back to all requirements</a></p>
      `;
      return c.html(html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Spec Engine — Requirement not found</title>
    ${styleTag}
  </head>
  <body>
    ${body}
  </body>
</html>`);
    }

    const r = (await res.json()) as Requirement;

    const body = html`
      ${navBar("requirements")}
      <div class="eyebrow">/ Requirement</div>
      <h1>${r.id}</h1>
      <p style="margin:0 0 1rem;display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">
        ${requirementStatusBadge(r.status)}
        <a href="/requirements">← Back to all requirements</a>
      </p>
      <dl>
        <dt>key</dt><dd>${r.key}</dd>
        <dt>seq</dt><dd>${r.seq}</dd>
        <dt>status</dt><dd>${r.status}</dd>
        <dt>spec_version</dt><dd>${r.spec_version}</dd>
        <dt>changed_at_version</dt><dd>${r.changed_at_version}</dd>
        <dt>superseded_by</dt><dd>${r.superseded_by ?? "—"}</dd>
        <dt>source_file</dt><dd>${r.source_file}</dd>
        <dt>line</dt><dd>${r.line}</dd>
        <dt>text</dt><dd>${r.text}</dd>
        <dt>why</dt><dd>${r.why ?? "—"}</dd>
      </dl>
    `;

    return c.html(html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Spec Engine — ${r.id}</title>
    ${styleTag}
  </head>
  <body>
    ${body}
  </body>
</html>`);
  });
}
