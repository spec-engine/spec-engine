// packages/webapp/src/pages/query.ts
//
// Plan 05-04 / Task 1 — SSR FTS search page (`GET /query?q=...`).
//
// D-09 / WORK-04 / Invariant #5: webapp source imports ONLY from
// `@spec-engine/shared` (types) and `hono` (runtime). NO `bun:sqlite`, no
// `node:fs`, no `fs`, no `bun`, no `node:path`, no `@spec-engine/spec-check`.
//
// Rendering shape — single self-contained `<!doctype html>` document via
// ONE `hono/html` tagged template (Pitfall 7 auto-escape). The `raw`
// helper is used ONLY for the static styles.css asset.
//
// Data fetch (Pitfall 6) — `app.request("/api/query?q=" + encodeURIComponent(q))`
// in-process. The `/api/query` route already translates FTS5 grammar
// errors (typed `searchFts: FTS5 query syntax error` prefix) to a
// sanitized 400 body in plan 05-03; this page re-renders that 400 inline
// without leaking SQLite internals (T-5-03-03).

import type { FtsHit } from "@spec-engine/shared";
import type { Hono } from "hono";
import { html, raw } from "hono/html";
import { comingSoonDoc, specId } from "./components";
import { toApiError } from "./data";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

const styleTag = raw(`<style>${styleSheet}</style>`);

/**
 * Feature flag: the FTS search UI is disabled ("coming soon"). The route stays
 * mounted so `/query` renders a friendly placeholder (not a 404) and the nav
 * item can point users at it, but no search runs and no `q` is reflected. Flip
 * to `true` to re-enable the implementation below verbatim. Typed `boolean`
 * (not the literal `false`) so the guarded search code stays reachable for the
 * type-checker and lint — it is the real implementation, parked, not dead code.
 */
const QUERY_ENABLED: boolean = false;

export function mountQuery(app: Hono): void {
  app.get("/query", async (c) => {
    if (!QUERY_ENABLED) return c.html(comingSoonDoc("query", "Query"));

    const q = (c.req.query("q") ?? "").trim();

    const form = html`
      <form method="get" action="/query">
        <label>
          Search
          <input type="text" name="q" value="${q}" placeholder="renewal charge" />
        </label>
        <button type="submit">Go</button>
      </form>
    `;

    // Empty form path — no q provided.
    if (q === "") {
      const body = html`
        ${navBar("query")}
        <div class="eyebrow">/ Query</div>
        <h1>Query</h1>
        <p class="lede">Full-text search across requirement text and rationale.</p>
        ${form}
        <p style="color:var(--fg-mute);font-family:var(--font-mono);font-size:0.82rem">Enter an FTS5 phrase to search requirement text + why.</p>
      `;
      return c.html(html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>spec-check — Query</title>
    ${styleTag}
  </head>
  <body>
    ${body}
  </body>
</html>`);
    }

    const res = await app.request(`/api/query?q=${encodeURIComponent(q)}`);

    // Anything not-ok other than the sanitized 400 (storage unavailable,
    // internal error) routes to the app error boundary with the engine's
    // structured hint instead of mis-parsing the error body as hits.
    if (!res.ok && res.status !== 400) {
      throw await toApiError(res, "/api/query");
    }

    if (res.status === 400) {
      // Sanitized error body from /api/query (plan 05-03 Pitfall 8). The
      // error string is server-authored ("FTS5 grammar error; wrap
      // phrases in double quotes"), not user-controlled — still goes
      // through auto-escape via the tagged template for defense-in-depth.
      const errBody = (await res.json()) as { error: string };
      const body = html`
        ${navBar("query")}
        <div class="eyebrow">/ Query</div>
        <h1>Query: ${q}</h1>
        ${form}
        <p class="error">${errBody.error}</p>
      `;
      return c.html(html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>spec-check — Query (error)</title>
    ${styleTag}
  </head>
  <body>
    ${body}
  </body>
</html>`);
    }

    const hits = (await res.json()) as FtsHit[];

    const body = html`
      ${navBar("query")}
      <div class="eyebrow">/ Query · ${hits.length} ${hits.length === 1 ? "hit" : "hits"}</div>
      <h1>Query: ${q}</h1>
      ${form}
      <ul>
        ${hits.map(
          (h) => html`
            <li>
              <a href="/requirements/${encodeURIComponent(h.req_id)}">${specId(h.req_id)}</a>
              <span style="color:var(--fg-dim)">${h.text}</span>
            </li>
          `,
        )}
      </ul>
    `;

    return c.html(html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>spec-check — Query: ${q}</title>
    ${styleTag}
  </head>
  <body>
    ${body}
  </body>
</html>`);
  });
}
