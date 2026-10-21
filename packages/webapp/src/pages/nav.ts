// A fixed CSS column (styles.css `.sidebar`) pins this to the left, so each
// page interpolates `navBar(active)` at the top of its <body> and needs no
// layout wrapper.

import { type FeatureKey, featureEnabled } from "@spec-engine/shared";
import { html } from "hono/html";

/** Inlined from src/assets/brand/mark-*.svg so the signal node fills with the live `--brand` token. */
const clampMark = html`<svg width="22" height="22" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <path d="M25 13 H13 V51 H25" stroke="var(--fg)" stroke-width="6" />
    <path d="M39 13 H51 V51 H39" stroke="var(--fg)" stroke-width="6" />
    <rect x="26" y="26" width="12" height="12" fill="var(--brand)" />
    <line x1="32" y1="13" x2="32" y2="24" stroke="var(--fg)" stroke-width="4" />
    <line x1="32" y1="40" x2="32" y2="51" stroke="var(--fg)" stroke-width="4" />
  </svg>`;

function link(href: string, key: string, label: string, active: string): ReturnType<typeof html> {
  const cls = key === active ? "sidebar-link active" : "sidebar-link";
  return html`<a href="${href}" class="${cls}"><span class="sidebar-dot"></span>${label}</a>`;
}

function comingSoon(label: string): ReturnType<typeof html> {
  return html`<span class="sidebar-link disabled" aria-disabled="true"><span class="sidebar-dot"></span><span class="sidebar-label">${label}<span class="soon">coming soon</span></span></span>`;
}

/** The same flag gates the route, so nav and route never disagree. */
function flagged(
  feature: FeatureKey,
  href: string,
  key: string,
  label: string,
  active: string,
): ReturnType<typeof html> {
  return featureEnabled(feature) ? link(href, key, label, active) : comingSoon(label);
}

/**
 * Propagation has no entry: it needs an :id, so it is reached from a
 * requirement and its pages pass `active = ""`.
 */
export function navBar(active = ""): ReturnType<typeof html> {
  return html`<nav class="sidebar">
  <a href="/" class="sidebar-brand">${clampMark}<span>Spec Engine</span></a>
  <div class="sidebar-scroll">
    <div class="sidebar-group">
      <div class="sidebar-group-label">Registry</div>
      ${link("/", "coverage", "Coverage", active)}
      ${link("/requirements", "requirements", "Requirements", active)}
      ${flagged("glossary", "/glossary", "glossary", "Glossary", active)}
    </div>
    <div class="sidebar-group">
      <div class="sidebar-group-label">Trace</div>
      ${flagged("relations", "/relations", "relations", "Relations", active)}
      ${flagged("provenance", "/provenance", "provenance", "Provenance", active)}
    </div>
    <div class="sidebar-group">
      <div class="sidebar-group-label">Workspace</div>
      ${flagged("query", "/query", "query", "Query", active)}
      ${flagged("editor", "/editor", "editor", "Editor", active)}
    </div>
    <div class="sidebar-group">
      <div class="sidebar-group-label">System</div>
      ${link("/setup", "setup", "Setup", active)}
      ${flagged("logs", "/logs", "logs", "Logs", active)}
    </div>
  </div>
  <div class="sidebar-footer">
    <span class="conn"><span class="conn-dot"></span>spec serve</span>
    <span class="read-only">READ-ONLY</span>
  </div>
</nav>`;
}
