// The page never builds mermaid syntax: the text comes from
// `/api/relations?format=mermaid`, the formatter `spec relations` prints, so
// the CLI and webapp diagrams cannot drift. The script tag is a template
// literal with `type="module"`, never interpolated, so the pages.test.ts XSS
// guard's bare-`<script>` ban still holds. Offline, the <pre> shows the
// readable mermaid source. Escaping `mermaidText` is safe: entity-escaped
// quotes parse back to literal quotes in the text content mermaid reads.

import { featureEnabled, type RelationRow } from "@spec-engine/shared";
import type { Hono } from "hono";
import { html, raw } from "hono/html";
import { comingSoonDoc } from "./components";
import { apiJson, apiText } from "./data";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

/** `raw` is safe here only because the stylesheet is a build-time asset, never request data. */
const styleTag = raw(`<style>${styleSheet}</style>`);

export function mountRelations(app: Hono): void {
  app.get("/relations", async (c) => {
    if (!featureEnabled("relations")) return c.html(comingSoonDoc("relations", "Relates graph"));

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
