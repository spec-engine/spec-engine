// packages/webapp/src/pages/setup.ts
//
// System → Setup (`GET /setup`): how Spec Engine reads your code. The scan
// mode comes from `/api/platform`, which carries platform-map's mode; the
// member table and the counts come from the same read-only routes the rest
// of the webapp uses, fetched in-process. The webapp stays hermetic: only
// @spec-engine/shared types and hono.

import type {
  CoverageRow,
  PlatformInfo,
  PlatformMode,
  Repo,
  Requirement,
} from "@spec-engine/shared";
import type { Hono } from "hono";
import { html, raw } from "hono/html";
import { badge } from "./components";
import { apiJson, excludeCanonical } from "./data";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

const styleTag = raw(`<style>${styleSheet}</style>`);

/** One scan-mode tile. `on` marks the detected mode. */
function modeTile(name: string, desc: string, on: boolean): ReturnType<typeof html> {
  return html`<div class="mode-tile ${on ? "active" : ""}">
    <div class="mode-name">${name}</div>
    <div class="mode-desc">${desc}</div>
  </div>`;
}

/** The tile label and the reading note for each platform-map mode. */
const MODE_TILES: Record<PlatformMode, { label: string; desc: string }> = {
  "multi-repo": { label: "Platform", desc: "many repos · one namespace" },
  monorepo: { label: "Monorepo", desc: "one repo · many packages" },
  "single-repo": { label: "Single repo", desc: "one repo" },
};

/** What the platform is reading, in words, for the note under the tiles. */
export function readingNote(mode: PlatformMode, memberCount: number): string {
  if (mode === "monorepo") return `${memberCount} workspace packages of one repository`;
  if (mode === "single-repo") return "one repository";
  return `${memberCount} member repositories`;
}

/** Mount the Setup page (`GET /setup`). */
export function mountSetup(app: Hono): void {
  app.get("/setup", async (c) => {
    const repos = await apiJson<Repo[]>(app, "/api/repos");
    const reqs = await apiJson<Requirement[]>(app, "/api/requirements");
    const cov = await apiJson<CoverageRow[]>(app, "/api/coverage");
    const platform = await apiJson<PlatformInfo>(app, "/api/platform");

    const domains = new Set(reqs.map((r) => r.key)).size;
    // @spec SERV-018
    const mode = platform.mode;
    // The canonical spec store holds requirement text, never code, so it is
    // excluded from the member table and every member count.
    const members = excludeCanonical(repos);
    const memberCount = members.length;
    const note = readingNote(mode, memberCount);

    // Distinct requirements each repo actually implements (its "bound specs").
    const boundByRepo = new Map<string, Set<string>>();
    for (const row of cov) {
      if (!row.implemented) continue;
      let set = boundByRepo.get(row.repo);
      if (!set) {
        set = new Set();
        boundByRepo.set(row.repo, set);
      }
      set.add(row.req_id);
    }

    const body = html`
      ${navBar("setup")}
      <div class="eyebrow">/ Setup · Platform mapping</div>
      <h1>How Spec Engine reads your code</h1>
      <p class="lede">
        The repos Spec Engine is bound to and whether the platform is mapped correctly —
        check the mapping here before trusting coverage.
      </p>

      <div class="setup-cards">
        <div class="card">
          <div class="card-label">Scan mode</div>
          <div class="mode-tiles">
            ${(Object.keys(MODE_TILES) as PlatformMode[]).map((m) =>
              modeTile(MODE_TILES[m].label, MODE_TILES[m].desc, mode === m),
            )}
          </div>
          <p class="mode-note">
            Reading <strong>${note}</strong> under one requirement namespace.
          </p>
        </div>

        <div class="card">
          <div class="card-label">Platform</div>
          <dl class="kv">
            <dt>version</dt><dd>v${platform.version} (derived: max domain version)</dd>
            <dt>mode</dt><dd>${mode}</dd>
            <dt>members</dt><dd>${memberCount}</dd>
            <dt>requirements</dt><dd>${reqs.length}</dd>
            <dt>domains</dt><dd>${domains}</dd>
            <dt>specs</dt><dd>spec-engine/&lt;KEY&gt;/SPEC.md</dd>
          </dl>
        </div>
      </div>

      <div class="section-label">
        Mapped members
        <span class="section-meta">${memberCount} mapped</span>
      </div>
      <div class="matrix-wrap">
        <table class="data-table">
          <thead>
            <tr><th>Member</th><th>Path</th><th>Pin</th><th>Bound</th><th>Mapping</th></tr>
          </thead>
          <tbody>
            ${members.map(
              (r) => html`
                <tr>
                  <td><span class="spec-id">${r.name}</span></td>
                  <td class="path">${r.path}</td>
                  <td>v${r.pinned_spec_version}</td>
                  <td>${boundByRepo.get(r.name)?.size ?? 0}</td>
                  <td>${badge("verified", "MAPPED")}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;

    return c.html(html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Spec Engine — Setup</title>
    ${styleTag}
  </head>
  <body>
    ${body}
  </body>
</html>`);
  });
}
