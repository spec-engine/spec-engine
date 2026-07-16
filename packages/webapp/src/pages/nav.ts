// packages/webapp/src/pages/nav.ts
//
// W4 — the shared workspace SHELL for every SSR page: the left sidebar from
// the Spec Check Dashboard design (brand kit → Spec Check Dashboard.dc.html).
// It keeps the "one self-contained html template per page" rendering shape —
// each page interpolates `navBar(active)` at the top of its <body>; a fixed
// CSS column (styles.css `.sidebar`) pins it to the left and the page body
// flows in the remaining space, so no per-page layout wrapper is needed.
//
// The brand lockup inlines the Spec Engine clamp mark from the brand kit
// (src/assets/brand/) so the signal node fills with the live `--brand` token.
//
// D-09 / Invariant #5: imports ONLY hono. The single argument is the page's
// own identity (a hardcoded literal each page passes for active-item
// highlighting) — NOT request data — so nothing user-controlled is ever
// interpolated. It still flows through the auto-escaping template regardless.

import { html } from "hono/html";

/** The clamp mark, inlined from src/assets/brand/mark-*.svg. */
const clampMark = html`<svg width="22" height="22" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <path d="M25 13 H13 V51 H25" stroke="var(--fg)" stroke-width="6" />
    <path d="M39 13 H51 V51 H39" stroke="var(--fg)" stroke-width="6" />
    <rect x="26" y="26" width="12" height="12" fill="var(--brand)" />
    <line x1="32" y1="13" x2="32" y2="24" stroke="var(--fg)" stroke-width="4" />
    <line x1="32" y1="40" x2="32" y2="51" stroke="var(--fg)" stroke-width="4" />
  </svg>`;

/** One sidebar link. `key` is the item's identity; `active` is the page's. */
function link(href: string, key: string, label: string, active: string): ReturnType<typeof html> {
  const cls = key === active ? "sidebar-link active" : "sidebar-link";
  return html`<a href="${href}" class="${cls}"><span class="sidebar-dot"></span>${label}</a>`;
}

/** A disabled sidebar item: not a link, with a "coming soon" caption. */
function comingSoon(label: string): ReturnType<typeof html> {
  return html`<span class="sidebar-link disabled" aria-disabled="true"><span class="sidebar-dot"></span><span class="sidebar-label">${label}<span class="soon">coming soon</span></span></span>`;
}

/**
 * The workspace sidebar. `active` is one of the item keys below (or "" for
 * pages with no nav home, e.g. a propagation detail). Grouped Registry /
 * Trace / Workspace, matching the design; only landable routes are linked
 * (propagation needs a :id, so it is reached from a requirement, not the nav).
 */
export function navBar(active = ""): ReturnType<typeof html> {
  return html`<nav class="sidebar">
  <a href="/" class="sidebar-brand">${clampMark}<span>Spec Engine</span></a>
  <div class="sidebar-scroll">
    <div class="sidebar-group">
      <div class="sidebar-group-label">Registry</div>
      ${link("/", "coverage", "Coverage", active)}
      ${link("/requirements", "requirements", "Requirements", active)}
      ${comingSoon("Glossary")}
    </div>
    <div class="sidebar-group">
      <div class="sidebar-group-label">Trace</div>
      ${comingSoon("Relations")}
      ${comingSoon("Provenance")}
    </div>
    <div class="sidebar-group">
      <div class="sidebar-group-label">Workspace</div>
      ${comingSoon("Query")}
      ${comingSoon("Editor")}
    </div>
    <div class="sidebar-group">
      <div class="sidebar-group-label">System</div>
      ${link("/setup", "setup", "Setup", active)}
      ${comingSoon("Logs")}
    </div>
  </div>
  <div class="sidebar-footer">
    <span class="conn"><span class="conn-dot"></span>spec serve</span>
    <span class="read-only">READ-ONLY</span>
  </div>
</nav>`;
}
