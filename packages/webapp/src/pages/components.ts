// Every interpolation must flow through the auto-escaping `hono/html` template;
// `raw` is reserved for build-time assets.

import type { PropagationRow, RequirementStatus } from "@spec-engine/shared";
import { html, raw } from "hono/html";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

/** `raw` is safe here only because the stylesheet is a build-time asset, never request data. */
const styleTag = raw(`<style>${styleSheet}</style>`);

export function specId(id: string): ReturnType<typeof html> {
  return html`<span class="spec-id">${id}</span>`;
}

export function comingSoonDoc(active: string, title: string): ReturnType<typeof html> {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Spec Engine — ${title}</title>
    ${styleTag}
  </head>
  <body>
    ${navBar(active)}
    <div class="eyebrow">/ ${title}</div>
    <h1>${title}</h1>
    <div class="coming-soon">
      <span class="badge drift nodot">Coming soon</span>
      <span>This view isn't available yet — browse the
        <a href="/requirements">requirement ledger</a> or the
        <a href="/">coverage matrix</a> in the meantime.</span>
    </div>
  </body>
</html>`;
}

export function badge(variant: string, label: string): ReturnType<typeof html> {
  return html`<span class="badge ${variant}">${label}</span>`;
}

const STATUS_LABEL: Record<RequirementStatus, string> = {
  Active: "ACTIVE",
  Superseded: "SUPERSEDED",
  Draft: "DRAFT",
  Deprecated: "DEPRECATED",
};

export function requirementStatusBadge(status: RequirementStatus): ReturnType<typeof html> {
  const variant =
    status === "Active"
      ? "active"
      : status === "Superseded"
        ? "superseded"
        : status === "Draft"
          ? "draft"
          : "retired";
  return badge(variant, STATUS_LABEL[status]);
}

/**
 * Drift is deliberately not folded into the color: it has its own column, and
 * folding it in would double-encode one signal. The label is the raw state
 * token so it stays greppable against the CLI output.
 */
export function propagationStateBadge(row: PropagationRow): ReturnType<typeof html> {
  let variant: string;
  switch (row.state) {
    case "MIGRATED_VERIFIED":
      variant = "verified";
      break;
    case "MIGRATED_UNVERIFIED":
      variant = "draft";
      break;
    case "ON_PREDECESSOR":
      variant = "superseded";
      break;
    default:
      variant = "unbound";
  }
  return badge(variant, row.state);
}

/** The state is carried by a glyph as well as a colour so it stays colorblind-safe. */
export function coverageGlyph(impl: 0 | 1, verif: 0 | 1): ReturnType<typeof html> {
  const [variant, char, title] =
    impl && verif
      ? ["both", "✓", "src + test"]
      : impl
        ? ["impl", "S", "src only"]
        : verif
          ? ["test", "T", "test only"]
          : ["none", "", "none"];
  return html`<span class="glyph ${variant}" title="${title}">${char}</span>`;
}

/**
 * Reuses the bind-glyph cube (`.glyph`) so a domain row lines up with its
 * requirement rows; the `heat` modifier only widens it for multi-digit counts
 * and applies the tint.
 */
export function heatCell(n: number, den: number): ReturnType<typeof html> {
  if (n === 0) {
    return html`<td class="matrix-cell heat-cell"><span class="glyph none heat" title="0/${den} implemented"></span></td>`;
  }
  const share = den > 0 ? n / den : 0;
  const intensity = Math.max(14, Math.round(share * 100));
  const hot = share >= 0.55 ? "hot" : "";
  return html`<td class="matrix-cell heat-cell"><span
    class="glyph heat ${hot}"
    style="background:color-mix(in srgb, var(--verified) ${intensity}%, var(--panel-2))"
    title="${n}/${den} implemented"
  >${n}</span></td>`;
}
