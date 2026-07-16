// packages/webapp/src/pages/logs.ts
//
// System → Logs (`GET /logs`) — a placeholder while the feature is disabled
// ("coming soon"). The route stays mounted so the nav can point at it and a
// direct hit renders the friendly placeholder (not a 404), matching the
// treatment used for Query / Relations / Provenance.
//
// D-09 / Invariant #5: imports ONLY hono + the local coming-soon helper.

import type { Hono } from "hono";
import { comingSoonDoc } from "./components";

/** Mount the Logs placeholder (`GET /logs`). */
export function mountLogs(app: Hono): void {
  app.get("/logs", (c) => c.html(comingSoonDoc("logs", "Logs")));
}
