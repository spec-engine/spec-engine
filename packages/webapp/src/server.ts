// Do not switch the embedded page to Bun.file(...): that resolves at runtime
// and fails inside the `bun build --compile` binary.

import { DEFAULT_BIND_HOST } from "@spec-engine/shared";
import { Hono } from "hono";
import { html as htmlTemplate } from "hono/html";
// The `.txt` extension is what types the text import as a string.
import html from "./index.html.txt" with { type: "text" };
import { mountCoverage } from "./pages/coverage";
import { registerErrorBoundary } from "./pages/data";
import { mountEditor } from "./pages/editor";
import { mountGlossary } from "./pages/glossary";
import { mountLogs } from "./pages/logs";
import { mountPropagation } from "./pages/propagation";
import { mountProvenance } from "./pages/provenance";
import { mountQuery } from "./pages/query";
import { mountRelations } from "./pages/relations";
import { mountRequirements } from "./pages/requirements";
import { mountSetup } from "./pages/setup";

/** Exported so the `serve --probe` smoke can assert the binary inlined it. */
export const placeholderHtml = html;

export function createApp(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.html(html));
  return app;
}

/**
 * Must be registered before the page routes for Hono to run it around them.
 *
 * @spec SERV-026
 */
function labelPlatform(app: Hono, platformName: string): void {
  const name = htmlTemplate`${platformName}`.toString();
  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.get("content-type")?.startsWith("text/html")) return;
    const body = (await c.res.text())
      .replace("<title>Spec Engine", `<title>${name} · Spec Engine`)
      .replace(
        "<span>Spec Engine</span></a>",
        `<span>Spec Engine</span><span class="sidebar-platform">${name}</span></a>`,
      );
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    c.res = new Response(body, { status: c.res.status, headers });
  });
}

/**
 * Each page reads its own `/api/*` routes in-process via `app.request(path)`,
 * so `mountApi` must be mounted on the same app. Registers `/`: never call it
 * on the `createApp()` probe app, which already binds `/`.
 */
export function mountWebapp(
  app: Hono,
  bindHost: string = DEFAULT_BIND_HOST,
  platformName?: string,
): Hono {
  if (platformName !== undefined) labelPlatform(app, platformName);
  // Before the pages: a failed API read renders the engine's hint, not Hono's bare 500.
  registerErrorBoundary(app);
  mountCoverage(app);
  mountRequirements(app);
  mountPropagation(app);
  mountQuery(app);
  mountRelations(app);
  mountProvenance(app);
  mountEditor(app, bindHost);
  mountSetup(app);
  mountGlossary(app);
  mountLogs(app);
  return app;
}
