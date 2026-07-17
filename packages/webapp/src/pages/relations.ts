// packages/webapp/src/pages/relations.ts
//
// RED-17 — SSR Relates entity-diagram page (`GET /relations`).
//
// D-09 / WORK-04 / Invariant #5: webapp source imports ONLY from
// `@spec-engine/shared` (types) and `hono` (runtime) — see coverage.ts. The
// mermaid SOURCE TEXT comes from `/api/relations?format=mermaid`
// (in-process via `app.request`, Pitfall 6), which renders through the
// engine's relations/format.ts — the same formatter `spec relations`
// prints. This page never builds mermaid syntax itself, so the CLI and
// webapp diagrams cannot drift (one engine, not two).
//
// Client-side rendering: the mermaid text is embedded in a
// `<pre class="mermaid">` and rendered by the mermaid ESM module loaded
// from the jsdelivr CDN in a STATIC `<script type="module">` tag — the
// first (and only) client script in the webapp, per the project's
// "htmx-style single script tag before any bundler" escalation path.
// The tag is a template LITERAL (never interpolated request data), so the
// pages.test.ts XSS guard's bare-`<script>` ban still holds. Without
// network access the page degrades gracefully: the <pre> shows the
// readable mermaid source.
//
// Escaping note (Pitfall 7): `${mermaidText}` flows through the
// auto-escaping `hono/html` tagged template. Entity-escaped quotes parse
// back to literal quotes in the element's text content, which is exactly
// what mermaid's startOnLoad reads.

import type { RelationRow } from "@spec-engine/shared";
import type { Hono } from "hono";
import { html, raw } from "hono/html";
import { comingSoonDoc } from "./components";
import { apiJson, apiText } from "./data";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

/** Embedded style tag — safe `raw` use: build-time asset, never request
 *  data (Pitfall 7). Mirrors coverage.ts. */
const styleTag = raw(`<style>${styleSheet}</style>`);

/** Feature flag: the Relates graph view is disabled ("coming soon"). The
 *  route stays mounted so `/relations` renders the placeholder (not a 404).
 *  Flip to `true` to re-enable the implementation below verbatim. Typed
 *  `boolean` (not literal `false`) so the parked code stays reachable. */
const RELATIONS_ENABLED: boolean = false;

/** Mount the Relates diagram page (`GET /relations`) onto an existing
 *  Hono app. The handler closes over `app` so it can read its own
 *  `/api/relations` routes in-process via `app.request` (Pitfall 6). */
export function mountRelations(app: Hono): void {
  app.get("/relations", async (c) => {
    if (!RELATIONS_ENABLED) return c.html(comingSoonDoc("relations", "Relates graph"));

    const rows = await apiJson<RelationRow[]>(app, "/api/relations");

    let body: ReturnType<typeof html>;
    if (rows.length === 0) {
      body = html`
        ${navBar("relations")}
        <div class="eyebrow">/ Relates graph</div>
        <h1>Relates graph</h1>
        <p class="lede">No Relates links indexed. Link requirements with a <code>**Relates:** KEY-NNN</code> line in <code>spec-engine/&lt;KEY&gt;/SPEC.md</code>, then re-run <code>spec index</code>.</p>
      `;
    } else {
      const mermaidText = await apiText(app, "/api/relations?format=mermaid");
      body = html`
        ${navBar("relations")}
        <div class="eyebrow">/ Relates graph</div>
        <h1>Relates graph</h1>
        <p class="lede">Requirements linked by explicit <code>Relates:</code> edges, rendered as a graph.</p>
        <pre class="mermaid">${mermaidText}</pre>
        <script type="module">
          import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
          mermaid.initialize({ startOnLoad: true, theme: "dark" });
        </script>
      `;
    }

    return c.html(html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Spec Engine — Relates</title>
    ${styleTag}
  </head>
  <body>
    ${body}
  </body>
</html>`);
  });
}
