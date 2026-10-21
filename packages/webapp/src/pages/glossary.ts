// The route stays mounted while the feature is off so a direct hit renders the
// placeholder, not a 404.

import type { Hono } from "hono";
import { comingSoonDoc } from "./components";

export function mountGlossary(app: Hono): void {
  app.get("/glossary", (c) => c.html(comingSoonDoc("glossary", "Glossary")));
}
