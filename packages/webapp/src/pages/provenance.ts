// The page must not import `@spec-engine/tracker`: tracker resolution happens
// engine-side behind `/api/provenance?resolve=1`, through the same decorator
// (renderProvenanceDecorated) as `spec provenance --resolve-issues`, so the
// two surfaces cannot drift.

import { featureEnabled } from "@spec-engine/shared";
import type { Hono } from "hono";
import { html, raw } from "hono/html";
import { comingSoonDoc } from "./components";
import { apiText } from "./data";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

/** `raw` is safe here only because the stylesheet is a build-time asset, never request data. */
const styleTag = raw(`<style>${styleSheet}</style>`);

export function mountProvenance(app: Hono): void {
  app.get("/provenance", async (c) => {
    if (!featureEnabled("provenance"))
      return c.html(comingSoonDoc("provenance", "Provenance matrix"));

    // One read, emptiness derived from it: renderProvenanceDecorated returns ""
    // for an empty matrix. A separate JSON empty-check would race a concurrent
    // `spec index` landing between the two reads.
    const text = await apiText(app, "/api/provenance?resolve=1");

    let body: ReturnType<typeof html>;
    if (text === "") {
      body = html`
        ${navBar("provenance")}
        <div class="eyebrow">/ Provenance matrix</div>
        <h1>Provenance matrix</h1>
        <p class="lede">No provenance links indexed. Add an <code>**Issues:** created:ENG-NNNN</code> line to a requirement in <code>spec-engine/&lt;KEY&gt;/SPEC.md</code>, then re-run <code>spec index</code>.</p>
      `;
    } else {
      // `text` carries resolved tracker titles and urls, which are
      // attacker-influenceable. Never wrap it in raw().
      body = html`
        ${navBar("provenance")}
        <div class="eyebrow">/ Provenance matrix</div>
        <h1>Provenance matrix</h1>
        <p class="lede">Requirement → tracker-issue provenance, resolved through the engine seam.</p>
        <pre class="provenance">${text}</pre>
      `;
    }

    return c.html(html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Spec Engine — Provenance</title>
    ${styleTag}
  </head>
  <body>
    ${body}
  </body>
</html>`);
  });
}
