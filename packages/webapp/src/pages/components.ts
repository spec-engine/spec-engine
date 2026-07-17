// packages/webapp/src/pages/components.ts
//
// Tokenized brand "components" for the SSR pages — the code translation of the
// brand kit's <StatusBadge> / <SpecId> primitives, rendered as `hono/html`
// fragments styled by the token classes in styles.css. Each helper maps a
// domain value (requirement status, propagation state, a coverage boolean) to
// the canonical status variant + label, so the mapping lives in ONE place and
// every page reads the same visual vocabulary.
//
// D-09 / WORK-04 / Invariant #5: imports ONLY `@spec-engine/shared` (types)
// and `hono` (runtime). No engine, no filesystem. Every interpolation flows
// through the auto-escaping `hono/html` tagged template (Pitfall 7).

import type { PropagationRow, RequirementStatus } from "@spec-engine/shared";
import { html, raw } from "hono/html";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

/** Embedded style tag (build-time asset, never request data — Pitfall 7). */
const styleTag = raw(`<style>${styleSheet}</style>`);

/** The stamped spec-id motif — mono, accent. Mirrors the kit's <SpecId plain>. */
export function specId(id: string): ReturnType<typeof html> {
  return html`<span class="spec-id">${id}</span>`;
}

/**
 * A full self-contained "coming soon" document for a feature-flagged-off route
 * (Query / Relations / Provenance). Keeps the page's own `<h1>` and nav-active
 * key so the shell reads correctly, and shows a Coming-soon notice instead of
 * the feature UI. Centralized so every disabled route renders identically.
 */
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

/** A status pill: `variant` is the CSS class (verified/drift/…); `label` the text. */
export function badge(variant: string, label: string): ReturnType<typeof html> {
  return html`<span class="badge ${variant}">${label}</span>`;
}

/** Webapp display labels for the engine's requirement-status vocabulary. The
 *  engine value stays "Retired" (CLI, storage, specs); the UI surfaces it as
 *  "DEPRECATED" per the product label choice. */
const STATUS_LABEL: Record<RequirementStatus, string> = {
  Active: "ACTIVE",
  Superseded: "SUPERSEDED",
  Draft: "DRAFT",
  Retired: "DEPRECATED",
};

/** Requirement lifecycle status → canonical badge variant + display label. */
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
 * Propagation state → badge, colored purely by the 5-state machine. Drift is a
 * separate axis (its own column / overlay), so it is NOT folded in here — that
 * keeps the state color honest and avoids double-encoding the same signal. The
 * label keeps the exact state token so the value stays greppable and the CLI
 * vocabulary is preserved.
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

/**
 * The coverage matrix glyph: one box encoding a requirement's bind state in a
 * repo from its two bits (implemented, verified). Colorblind-safe (the brand
 * kit's default): the state is carried by a glyph AND colour, not colour alone
 * — ✓ src+test, S src only, T test only, empty none.
 */
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
 * One platform-health heat cell: the count of a domain's active requirements
 * implemented in one member, tinted by the share of the domain that member
 * covers. Renders the SAME cube as the requirement rows' bind glyphs
 * (`.glyph` — the `heat` modifier only widens for multi-digit counts and
 * applies the tint), carrying a number instead of a letter; zero renders
 * the same empty bordered square a `none` bind cell does. Absorbed from
 * the retired /report grid — the Coverage matrix's domain header rows are
 * the surviving surface.
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
