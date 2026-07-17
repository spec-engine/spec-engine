// packages/webapp/src/pages/propagation.ts
//
// Plan 05-04 / Task 1 — SSR propagation view (`GET /propagation/:id`).
// Renders per-member-repo propagation state for the target requirement
// (PROP-02 5-state machine + drift overlay).
//
// D-09 / WORK-04 / Invariant #5: webapp source imports ONLY from
// `@spec-engine/shared` (types) and `hono` (runtime). NO `bun:sqlite`, no
// `node:fs`, no `fs`, no `bun`, no `node:path`, no `@spec-engine/spec-engine`.
//
// Rendering shape — single self-contained `<!doctype html>` document via
// ONE `hono/html` tagged template (Pitfall 7 auto-escape). The `raw`
// helper is used ONLY for the static styles.css asset.
//
// Data fetch — `app.request("/api/propagation/" + encodeURIComponent(id))`
// in-process (Pitfall 6).

import type { PropagationRow } from "@spec-engine/shared";
import type { Hono } from "hono";
import { html, raw } from "hono/html";
import { badge, propagationStateBadge, specId } from "./components";
import { apiJson } from "./data";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

const styleTag = raw(`<style>${styleSheet}</style>`);

export function mountPropagation(app: Hono): void {
  app.get("/propagation/:id", async (c) => {
    const id = c.req.param("id");
    const rows = await apiJson<PropagationRow[]>(app, `/api/propagation/${encodeURIComponent(id)}`);

    const body = html`
      ${navBar("")}
      <div class="eyebrow">/ Propagation</div>
      <h1>Propagation: ${id}</h1>
      <p class="lede">
        Where ${specId(id)} stands in each member — the 5-state propagation machine, with
        a drift overlay flagging members pinned behind the requirement's current version.
      </p>
      <table>
        <thead>
          <tr><th>Member</th><th>State</th><th>Via</th><th>Drift</th></tr>
        </thead>
        <tbody>
          ${rows.map(
            (r) => html`
              <tr>
                <td>${r.repo}</td>
                <td>${propagationStateBadge(r)}</td>
                <td>${r.via_req_id ? specId(r.via_req_id) : html`<span style="color:var(--fg-mute)">—</span>`}</td>
                <td>${r.drifted ? badge("drift", "DRIFT") : html`<span style="color:var(--fg-mute)">—</span>`}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    `;

    return c.html(html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>spec-check — Propagation ${id}</title>
    ${styleTag}
  </head>
  <body>
    ${body}
  </body>
</html>`);
  });
}
