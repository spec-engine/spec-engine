// packages/webapp/src/pages/provenance.ts
//
// Phase 16 Plan 02 / Task 2 (PWEB-02 / PWEB-03) — SSR provenance page
// (`GET /provenance`).
//
// D-09 / WORK-04 / Invariant #5: webapp source imports ONLY from
// `@spec-engine/shared` (types) and `hono` (runtime). This page in particular MUST
// NOT import the tracker adapter package (nor `@spec-engine/spec-check`): all tracker
// resolution happens ENGINE-SIDE behind `/api/provenance?resolve=1`. The page reads that
// decorated TEXT seam in-process via `app.request` (Pitfall 6) — exactly the
// way relations.ts reads `/api/relations?format=mermaid`. Because both the CLI
// (`spec provenance --resolve-issues`) and this page render through the ONE
// shared engine decorator (renderProvenanceDecorated), the two surfaces cannot
// drift (one engine, not two).
//
// Degradation (PWEB-03): with no SPEC_TRACKER_TOKEN the engine seam returns
// the bare opaque issue ids + the "set SPEC_TRACKER_TOKEN" hint — identical to
// the CLI degraded output. The page renders that text verbatim.
//
// Escaping (Pitfall 4 / T-16-XSS): the decorated text MAY contain resolved
// Linear `title`/`url` strings (attacker-influenceable). `${text}` flows
// through the auto-escaping `hono/html` tagged template, so any `<`/`&`/`"` in
// a resolved field is entity-escaped — never rendered as markup. `raw()` is
// used ONLY for the static stylesheet (build-time asset, never request data).

import type { Hono } from "hono";
import { html, raw } from "hono/html";
import { comingSoonDoc } from "./components";
import { apiText } from "./data";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

/** Embedded style tag — safe `raw` use: build-time asset, never request data
 *  (Pitfall 4). Mirrors relations.ts / coverage.ts. */
const styleTag = raw(`<style>${styleSheet}</style>`);

/** Feature flag: the provenance matrix view is disabled ("coming soon"). The
 *  route stays mounted so `/provenance` renders the placeholder (not a 404).
 *  Flip to `true` to re-enable the implementation below verbatim. Typed
 *  `boolean` (not literal `false`) so the parked code stays reachable. */
const PROVENANCE_ENABLED: boolean = false;

/** Mount the provenance page (`GET /provenance`) onto an existing Hono app.
 *  The handler closes over `app` so it can read its own `/api/provenance`
 *  routes in-process via `app.request` (Pitfall 6) — never `fetch("http://…")`. */
export function mountProvenance(app: Hono): void {
  app.get("/provenance", async (c) => {
    if (!PROVENANCE_ENABLED) return c.html(comingSoonDoc("provenance", "Provenance matrix"));

    // WR-03: read the DECORATED text seam ONCE and derive emptiness from it.
    // The text arm returns "" for an empty matrix (format.ts
    // renderProvenanceDecorated → `if (sorted.length === 0) return ""`), so an
    // empty body IS the empty matrix — no separate JSON probe needed. The
    // previous two-read shape (an empty-check JSON read + the decorated read)
    // opened a TOCTOU window: a concurrent `spec index` landing between the
    // reads could let the empty check see N rows while the decorated read saw 0
    // (or vice-versa), and it materialized the matrix twice per render. One read
    // closes both the inconsistency window and the redundant work.
    //
    // Resolution + decoration are done ENGINE-SIDE (the page never resolves;
    // D-09 forbids a @spec-engine/tracker import here). With no token this degrades to
    // bare ids + the token hint, identical to the CLI.
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
      // `${text}` flows through hono/html auto-escaping (Pitfall 4 / T-16-XSS):
      // any resolved title/url is HTML-escaped. NEVER wrap it in raw().
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
    <title>spec-check — Provenance</title>
    ${styleTag}
  </head>
  <body>
    ${body}
  </body>
</html>`);
  });
}
