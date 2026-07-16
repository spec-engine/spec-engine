// packages/webapp/src/server.ts
//
// Phase 1 webapp scaffold (D-14, D-16). The createApp() factory returns a
// Hono app that serves the placeholder index.html embedded at compile time
// via Bun's `import ... with { type: "text" }` attribute (Pattern 4).
//
// IMPORTANT: do NOT switch to Bun.file("./index.html") — that resolves at
// runtime and fails inside the `bun build --compile` binary (Pitfall 10).
// IMPORTANT: this package may NOT import bun:sqlite, node:fs, fs, bun,
// node:path, or anything from @spec-engine/spec-check (enforced by D-09 lint).

import { Hono } from "hono";
// Bun inlines the file as a string when imported with the `text` attribute.
// TS's ambient *.html declaration models the full-stack bundler shape, so we
// cast through `unknown` to a string for the Phase 1 text-import path
// (Pattern 4 / D-14). Runtime semantics: `bun build --compile` embeds the
// raw file contents as a UTF-8 string.
import htmlRaw from "./index.html" with { type: "text" };
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

const html = htmlRaw as unknown as string;

/** The embedded HTML string — exported so the `serve --probe` smoke can
 *  assert the binary really inlined it (D-14). */
export const placeholderHtml = html;

export function createApp(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.html(html));
  return app;
}

/**
 * Plan 05-04 — mount the 5 SSR pages onto an existing Hono app and return
 * the same app for chainability (RED-17 added /relations). Mirrors
 * `mountApi(app, storage)`'s "mutate-one-app" composition (RESEARCH Open
 * Q1) so plan 05-05's `commands/serve.ts` can compose engine + webapp on
 * one Hono instance:
 *
 *   const app = new Hono();
 *   mountApi(app, storage);   // /api/*  (engine)
 *   mountWebapp(app);         // /, /requirements, /propagation/:id, /query, /relations, /provenance  (webapp)
 *
 * Each page handler closes over `app` so it can read its own `/api/*`
 * routes in-process via `app.request(path)` (Pitfall 6 — never
 * `fetch("http://...")`).
 *
 * NOTE: `mountWebapp` registers `/` — do NOT call it on the app returned
 * by `createApp()` (the Phase 1 probe factory) because that one already
 * has `/` bound to the placeholder. Plan 05-05's real-serve composer
 * builds a fresh `new Hono()` and calls both mount functions on it.
 */
export function mountWebapp(app: Hono): Hono {
  // Error boundary first: a page whose API read fails (e.g. the engine's
  // storage layer is unavailable — sandboxed file locks, contention) renders
  // a readable error page with the engine's hint instead of Hono's bare-text
  // 500. See pages/data.ts.
  registerErrorBoundary(app);
  mountCoverage(app);
  mountRequirements(app);
  mountPropagation(app);
  mountQuery(app);
  mountRelations(app);
  mountProvenance(app);
  mountEditor(app);
  mountSetup(app);
  mountGlossary(app);
  mountLogs(app);
  return app;
}
