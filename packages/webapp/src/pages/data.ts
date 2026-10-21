// Pages read data through `app.request(path)` in-process, never
// `fetch("http://...")`. A non-2xx response must become an ApiError: parsing an
// error body as rows buries the cause (a storage 503) under a JSON SyntaxError.
// The storage diagnosis arrives over the API as the engine-authored `hint`
// (storage/errors.ts); this module touches neither fs nor sqlite.

import type { Hono } from "hono";
import { html, raw } from "hono/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

/** `raw` is safe here only because the stylesheet is a build-time asset, never request data. */
const styleTag = raw(`<style>${styleSheet}</style>`);

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

export async function apiJson<T>(app: Hono, path: string): Promise<T> {
  const res = await app.request(path);
  if (!res.ok) throw await toApiError(res, path);
  return (await res.json()) as T;
}

export async function apiText(app: Hono, path: string): Promise<string> {
  const res = await app.request(path);
  if (!res.ok) throw await toApiError(res, path);
  return await res.text();
}

function errorDoc(message: string, hint: string | null): ReturnType<typeof html> {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Spec Engine — Error</title>
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

/** Unknown errors show a generic line: details go to the server terminal, never the browser. */
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

/** Must match the repo-row name discover.ts gives the canonical spec store. */
export const CANONICAL_REPO_NAME = "spec-engine";

/**
 * The canonical dir is never tag-scanned, so its coverage is structurally
 * zero. It is hidden from webapp surfaces only; the index and `spec map` keep it.
 */
export function excludeCanonical<T extends { name: string }>(rows: T[]): T[] {
  return rows.filter((r) => r.name !== CANONICAL_REPO_NAME);
}
