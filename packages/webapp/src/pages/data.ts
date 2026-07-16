// packages/webapp/src/pages/data.ts
//
// In-process API data helpers + the app-level error boundary, shared by every
// SSR page.
//
// Motivation (webapp hardening follow-up): every page used to do
// `(await (await app.request(path)).json())` with no `res.ok` check. When the
// engine's storage layer failed (e.g. WAL locks denied under a coding-agent
// sandbox → SQLITE_IOERR_VNODE → /api/* 503), the page crashed on
// `SyntaxError: Failed to parse JSON` — a downstream symptom that buried the
// actual cause. These helpers turn a non-2xx API response into a typed
// {@link ApiError} carrying the engine's structured `{error, hint}` body, and
// {@link registerErrorBoundary} renders it as a readable error page instead
// of Hono's bare-text 500.
//
// D-09 / WORK-04 / Invariant #5: webapp source imports ONLY from
// `@spec-engine/shared` (types) and `hono` (runtime) — this module touches
// neither fs nor sqlite; the storage diagnosis arrives OVER the API seam as
// the `hint` field authored by the engine (storage/errors.ts).
//
// Pitfall 6 still holds: `app.request(path)` in-process, never
// `fetch("http://...")`.

import type { Hono } from "hono";
import { html, raw } from "hono/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

/** Embedded style tag — `raw` is safe here because `styleSheet` originates
 *  from a source file at build time, never from request data (Pitfall 7). */
const styleTag = raw(`<style>${styleSheet}</style>`);

/**
 * A non-2xx response from the engine's `/api/*` plane, carrying the
 * structured body when one was present: `message` is the server-authored
 * `error` field (e.g. "storage_unavailable"), `hint` the actionable
 * follow-up (e.g. the sandbox file-lock explanation). Thrown by
 * {@link apiJson}/{@link apiText}; rendered by {@link registerErrorBoundary}.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly hint: string | null;
  constructor(message: string, status: number, hint: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.hint = hint;
  }
}

/** Build the {@link ApiError} for a non-ok API response, extracting the
 *  engine's structured `{error, hint}` body when the payload is JSON. */
export async function toApiError(res: Response, path: string): Promise<ApiError> {
  let message = `the engine API responded ${res.status} for ${path}`;
  let hint: string | null = null;
  try {
    const body = (await res.json()) as { error?: unknown; hint?: unknown };
    if (typeof body.error === "string") message = body.error;
    if (typeof body.hint === "string") hint = body.hint;
  } catch {
    // Non-JSON error body — keep the status-line message.
  }
  return new ApiError(message, res.status, hint);
}

/** GET `path` in-process and parse the JSON body; throws {@link ApiError}
 *  on any non-2xx status instead of mis-parsing an error payload as rows. */
export async function apiJson<T>(app: Hono, path: string): Promise<T> {
  const res = await app.request(path);
  if (!res.ok) throw await toApiError(res, path);
  return (await res.json()) as T;
}

/** GET `path` in-process and read the text body; throws {@link ApiError}
 *  on any non-2xx status. For the text seams (?format=mermaid, ?resolve=1). */
export async function apiText(app: Hono, path: string): Promise<string> {
  const res = await app.request(path);
  if (!res.ok) throw await toApiError(res, path);
  return await res.text();
}

/** The full error document: same shell as every page (styles + nav) so a
 *  broken data plane still looks like the workspace, not a crash. */
function errorDoc(message: string, hint: string | null): ReturnType<typeof html> {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>spec-check — Error</title>
    ${styleTag}
  </head>
  <body>
    ${navBar()}
    <div class="eyebrow">/ Error</div>
    <h1>This page can't load right now</h1>
    <p class="lede">The engine behind this workspace reported a problem while fetching the page's data.</p>
    <p class="error">${message}</p>
    ${hint === null ? "" : html`<p class="lede">${hint}</p>`}
    <p><a href="/">Back to the coverage matrix</a></p>
  </body>
</html>`;
}

/**
 * App-level error boundary, registered once by `mountWebapp`. SSR page
 * failures render {@link errorDoc} (with the engine's hint when the failure
 * was a structured {@link ApiError}); `/api/*` errors that escaped the
 * engine's own storage backstop stay JSON-shaped. Unknown errors show a
 * generic line — the details go to the server terminal, not the browser.
 */
export function registerErrorBoundary(app: Hono): void {
  app.onError((err, c) => {
    console.error("spec serve: request failed:", err);
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith("/api/")) {
      return c.json({ error: "internal error" }, 500);
    }
    if (err instanceof ApiError) {
      return c.html(errorDoc(err.message, err.hint), err.status as ContentfulStatusCode);
    }
    return c.html(errorDoc("unexpected server error — check the `spec serve` terminal", null), 500);
  });
}

/** The canonical spec store's fixed repo-row name (discover.ts contract). */
export const CANONICAL_REPO_NAME = "spec-engine";

/**
 * Drop the canonical `spec-engine` row from a member-facing collection. The
 * canonical dir is the requirement manifest, not implementation territory —
 * it is never tag-scanned, so every coverage/bound number it could render is
 * structurally zero. Webapp surfaces (Setup table, Coverage columns, Report
 * heatmap columns) show MEMBERS; the canonical row stays in the index and
 * the CLI's `spec map` output, whose contract is unchanged.
 */
export function excludeCanonical<T extends { name: string }>(rows: T[]): T[] {
  return rows.filter((r) => r.name !== CANONICAL_REPO_NAME);
}
