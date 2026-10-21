import { type FtsHit, featureEnabled } from "@spec-engine/shared";
import type { Hono } from "hono";
import { html, raw } from "hono/html";
import { comingSoonDoc, specId } from "./components";
import { toApiError } from "./data";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

const styleTag = raw(`<style>${styleSheet}</style>`);

export function mountQuery(app: Hono): void {
  app.get("/query", async (c) => {
    if (!featureEnabled("query")) return c.html(comingSoonDoc("query", "Query"));

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
    <title>Spec Engine — Query</title>
    ${styleTag}
  </head>
  <body>
    ${body}
  </body>
</html>`);
    }

    const res = await app.request(`/api/query?q=${encodeURIComponent(q)}`);

    // A 400 is the route's sanitized FTS5 grammar error, rendered inline; any
    // other failure goes to the error boundary rather than parsing as hits.
    if (!res.ok && res.status !== 400) {
      throw await toApiError(res, "/api/query");
    }

    if (res.status === 400) {
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
    <title>Spec Engine — Query (error)</title>
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
    <title>Spec Engine — Query: ${q}</title>
    ${styleTag}
  </head>
  <body>
    ${body}
  </body>
</html>`);
  });
}
