// packages/webapp/src/pages/glossary.ts
//
// Registry → Glossary (`GET /glossary`) — a placeholder while the feature is
// disabled ("coming soon"; RED-80). The route stays mounted so the nav can
// point at it and a direct hit renders the friendly placeholder (not a 404),
// matching the treatment used for Query / Relations / Provenance / Logs.
// The real page will render the TERM store (the glossary the CLI generates
// GLOSSARY.md from) over the derived index.
//
// D-09 / Invariant #5: imports ONLY hono + the local coming-soon helper.

import type { Hono } from "hono";
import { comingSoonDoc } from "./components";

/** Mount the Glossary placeholder (`GET /glossary`). */
export function mountGlossary(app: Hono): void {
  app.get("/glossary", (c) => c.html(comingSoonDoc("glossary", "Glossary")));
}
