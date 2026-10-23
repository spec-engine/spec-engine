import type { CoverageRow, Requirement, RequirementRecord } from "@spec-engine/shared";
import type { Hono } from "hono";
import { html, raw } from "hono/html";
import { requirementStatusBadge, specId } from "./components";
import { apiJson, toApiError } from "./data";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

const styleTag = raw(`<style>${styleSheet}</style>`);

/** The engine's `ReqTagRow`, redeclared because the import fence forbids
 *  reaching into `@spec-engine/spec-engine`. */
interface ReqTagRow {
  req_id: string;
  repo: string;
  file: string;
  line: number;
  kind: string;
  level: string | null;
}

interface PanelReq {
  req: Requirement;
  impl: number;
  verif: number;
  chain: Requirement[]; // most-recent-first; length 1 = standalone
  tags: ReqTagRow[];
}

const KIND_LABEL: Record<string, string> = {
  implements: "impl",
  verifies: "test",
  documents: "doc",
};

interface DomainGroup {
  key: string;
  reqs: PanelReq[];
}

const chevron = raw(
  '<svg class="domain-chevron" width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 3 L11 8 L5 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
);

/** Class and attribute toggles only: no innerHTML. The XSS guard forbids only a
 *  bare `<script>`, so the script must keep `type="module"`. */
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

/** `byId` spans every domain, so a cross-domain move stays in the chain.
 *  @spec SERV-016 */
function lineageOf(
  byId: Map<string, Requirement>,
  predecessorOf: Map<string, string>,
  r: Requirement,
): Requirement[] {
  let rootId = r.id;
  const back = new Set<string>();
  for (;;) {
    const prev = predecessorOf.get(rootId);
    if (prev === undefined || back.has(rootId)) break;
    back.add(rootId);
    rootId = prev;
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

/** Lineage walks `allReqs`, not `listed`, so a visible requirement's history
 *  keeps the superseded predecessors the default filter hides as rows.
 *  @spec SERV-014 */
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

/** `spec_version` is the domain envelope's version, shared by every requirement
 *  in the domain, not a per-requirement revision count. */
function verPill(r: Requirement, versioned: boolean): ReturnType<typeof html> {
  return html`<span class="ver-pill ${versioned ? "versioned" : ""}" title="domain spec version (envelope)">v${r.spec_version}</span>`;
}

/** Deliberately not `spec_version`, which is the domain's current version and
 *  identical for every requirement in it. An entry superseded before
 *  `superseded_at_version` existed shows no number: the value is unrecoverable. */
function chainVerLabel(v: Requirement): ReturnType<typeof html> {
  const dead = v.status === "Superseded" || v.status === "Deprecated";
  if (dead && v.superseded_at_version != null) {
    return html`<span class="chain-ver">superseded at v${v.superseded_at_version}</span>`;
  }
  if (dead) {
    return html`<span class="chain-ver muted" title="superseded before the version was recorded">version not recorded</span>`;
  }
  return html`<span class="chain-ver current-ver">current</span>`;
}

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

function renderBody(
  domains: DomainGroup[],
  defaultId: string,
  reqTotal: number,
  showAll: boolean,
  hiddenCount: number,
): ReturnType<typeof html> {
  // @spec SERV-014
  // The toggle is a plain link so the filter works without JS.
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

export function mountRequirements(app: Hono): void {
  app.get("/requirements", async (c) => {
    const reqs = await apiJson<Requirement[]>(app, "/api/requirements");
    const coverage = await apiJson<CoverageRow[]>(app, "/api/coverage");

    // @spec SERV-014
    const showAll = c.req.query("all") === "1";
    const listed = showAll
      ? reqs
      : reqs.filter((r) => r.status !== "Superseded" && r.status !== "Deprecated");
    const hiddenCount = reqs.filter(
      (r) => r.status === "Superseded" || r.status === "Deprecated",
    ).length;

    // Parallel so page latency is one round of the derived index, not N sequential reads.
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

    const r = (await res.json()) as RequirementRecord;
    // @spec SCHM-040
    const sites = (list: readonly { file: string; line: number }[]) =>
      list.length === 0
        ? "—"
        : html`<ul>
            ${list.map((s) => html`<li><code>${s.file}:${s.line}</code></li>`)}
          </ul>`;

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
        <dt>implemented_in</dt><dd>${sites(r.implemented_in)}</dd>
        <dt>verified_in</dt><dd>${sites(r.verified_in)}</dd>
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
