// packages/webapp/src/pages/setup.ts
//
// System → Setup (`GET /setup`) — the brand kit's "How Spec Engine reads your
// code" view: the platform's scan mode, a summary of what's mapped, and the
// table of member repositories. Everything is derived from read-only engine
// seams (repos + requirements + coverage) fetched in-process via app.request
// (Pitfall 6); the webapp stays hermetic (D-09 / Invariant #5 — only
// @spec-engine/shared types + hono).

import type { CoverageRow, Repo, Requirement } from "@spec-engine/shared";
import type { Hono } from "hono";
import { html, raw } from "hono/html";
import { badge } from "./components";
import { apiJson, CANONICAL_REPO_NAME, excludeCanonical } from "./data";
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

export type ScanMode = "platform" | "monorepo" | "single";

/**
 * RED-93: classify the scan mode from the mapped rows. The canonical
 * `spec-engine` row is the spec store, not a code member — counting it made
 * a rung-1 single repo (two rows) read "platform". Workspace expansion is
 * the monorepo signal: a sub-member's name is its platform-relative path
 * (`packages/engine` — the discover.ts naming contract), so members that
 * all share one slashed root are one repository's packages, not sibling
 * repos. Mixed shapes (any flat sibling, or several roots) stay "platform".
 */
// @spec SERV-004
export function detectScanMode(repos: ReadonlyArray<Pick<Repo, "name">>): ScanMode {
  const members = repos.filter((r) => r.name !== CANONICAL_REPO_NAME);
  const oneWorkspaceRoot =
    members.length > 0 &&
    members.every((m) => m.name.includes("/")) &&
    new Set(members.map((m) => m.name.split("/")[0])).size === 1;
  if (oneWorkspaceRoot) return "monorepo";
  return members.length <= 1 ? "single" : "platform";
}

/** Mount the Setup page (`GET /setup`). */
export function mountSetup(app: Hono): void {
  app.get("/setup", async (c) => {
    const repos = await apiJson<Repo[]>(app, "/api/repos");
    const reqs = await apiJson<Requirement[]>(app, "/api/requirements");
    const cov = await apiJson<CoverageRow[]>(app, "/api/coverage");
    const platform = await apiJson<{
      version: number;
      source: string;
    }>(app, "/api/platform");

    const domains = new Set(reqs.map((r) => r.key)).size;
    const mode = detectScanMode(repos);
    // The canonical spec store is the requirement manifest, not
    // implementation territory — it never carries a bound spec, so it is
    // excluded from the member table and every member count.
    const members = excludeCanonical(repos);
    const memberCount = members.length;
    const readingNote =
      mode === "monorepo"
        ? `${memberCount} workspace packages of one repository`
        : mode === "single"
          ? "one repository"
          : `${memberCount} member repositories`;

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
            ${modeTile("Platform", "many repos · one namespace", mode === "platform")}
            ${modeTile("Monorepo", "one repo · many packages", mode === "monorepo")}
            ${modeTile("Single repo", "one repo", mode === "single")}
          </div>
          <p class="mode-note">
            Reading <strong>${readingNote}</strong> under one requirement namespace.
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
    <title>spec-check — Setup</title>
    ${styleTag}
  </head>
  <body>
    ${body}
  </body>
</html>`);
  });
}
