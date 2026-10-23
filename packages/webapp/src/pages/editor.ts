// Every write is forwarded in-process to the engine's `/api/requirements`
// routes, which own all validation: nothing is re-validated here, and the
// engine's diagnostics render unchanged.
//
// The browser posts to `/editor/*`, never to `/api/requirements`, and the
// in-process forward carries no Origin header, so the engine's Origin guard
// never sees the browser request. The same-origin check must therefore live
// here, or a drive-by localhost page could auto-submit a form-urlencoded POST
// (a CORS simple request, no preflight) and mutate the local spec store.
//
// Echoed user text (statement, why, id) must stay inside `hono/html`
// templates; `raw` is for the static stylesheet only.

import {
  DEFAULT_BIND_HOST,
  type Diagnostic,
  featureDisabledMessage,
  featureEnabled,
  isServedHostname,
} from "@spec-engine/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { html, raw } from "hono/html";
import { comingSoonDoc } from "./components";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

const styleTag = raw(`<style>${styleSheet}</style>`);

/** Must match the engine's MAX_WRITE_BODY_BYTES. */
const MAX_EDITOR_BODY_BYTES = 64 * 1024;

/**
 * Mirrors the engine's `rejectCrossOrigin`: the Host pin blocks DNS rebinding,
 * and a present Origin must match the request host. An absent Origin is allowed
 * because the in-process `app.request` forward sends none.
 */
function crossOriginRejected(c: Context, bindHost: string): boolean {
  const selfUrl = new URL(c.req.url);
  if (!isServedHostname(selfUrl.hostname, bindHost)) return true;
  const origin = c.req.header("origin");
  if (origin === undefined) return false;
  try {
    return new URL(origin).host !== selfUrl.host;
  } catch {
    return true;
  }
}

/**
 * Counts actual bytes, not the declared `Content-Length` alone: a header-only
 * check is bypassed by an absent or malformed header (`NaN > cap` is false).
 */
const editorBodyLimit = bodyLimit({
  maxSize: MAX_EDITOR_BODY_BYTES,
  onError: (c) => c.html(rejectPage("request body too large"), 413),
});

function rejectPage(message: string): ReturnType<typeof html> {
  return page(
    "Rejected",
    html`
      ${navBar("editor")}
      <h1>Not saved</h1>
      <p class="error">${message}</p>
      <p><a href="/editor">Back to editor</a></p>
    `,
  );
}

function page(title: string, body: ReturnType<typeof html>): ReturnType<typeof html> {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Spec Engine — ${title}</title>
    ${styleTag}
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

/** File values read as empty. */
function field(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  return typeof v === "string" ? v : "";
}

async function renderResult(res: Response): Promise<ReturnType<typeof html>> {
  const data = (await res.json()) as {
    ok?: boolean;
    id?: string;
    error?: string;
    diagnostics?: Diagnostic[];
    possible_duplicates?: { id: string; score: number }[];
  };

  if (res.ok && data.ok) {
    return page(
      "Saved",
      html`
        ${navBar("editor")}
        <h1>Saved</h1>
        <p class="success">Requirement <code>${data.id}</code> was written.</p>
        ${(data.possible_duplicates ?? []).map(
          (d) =>
            html`<p class="warning">
              Possible duplicate of
              <a href="/requirements/${encodeURIComponent(d.id)}"><code>${d.id}</code></a>
              (${d.score.toFixed(2)})
            </p>`,
        )}
        <p><a href="/requirements/${encodeURIComponent(data.id ?? "")}">View requirement</a></p>
        <p><a href="/editor">Back to editor</a></p>
      `,
    );
  }

  const diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : [];
  return page(
    "Rejected",
    html`
      ${navBar("editor")}
      <h1>Not saved</h1>
      <p class="error">${data.error ?? "Write rejected."}</p>
      ${
        diagnostics.length > 0
          ? html`<ul>
              ${diagnostics.map((d) => html`<li><code>${d.code}</code> — ${d.detail}</li>`)}
            </ul>`
          : ""
      }
      <p><a href="/editor">Back to editor</a></p>
    `,
  );
}

export function mountEditor(app: Hono, bindHost: string = DEFAULT_BIND_HOST): void {
  app.get("/editor", (c) => {
    if (!featureEnabled("editor")) return c.html(comingSoonDoc("editor", "Editor"));
    const body = html`
      ${navBar("editor")}
      <div class="eyebrow">/ Editor</div>
      <h1>Editor</h1>
      <p class="lede">
        Create or amend a requirement. Every write is forwarded in-process to the one engine
        validator — invalid input comes back with the engine's own diagnostics, unchanged.
      </p>

      <section>
        <h2>Create a requirement</h2>
        <form method="post" action="/editor/create">
          <label>
            Domain key
            <input type="text" name="key" placeholder="BILLING" required />
          </label>
          <label>
            Statement
            <textarea name="statement" rows="3" placeholder="When … then …"></textarea>
          </label>
          <label>
            Why (optional)
            <textarea name="why" rows="2"></textarea>
          </label>
          <label>
            Relates to (optional, comma-separated ids)
            <input type="text" name="relates" placeholder="BILLING-001, BILLING-002" />
          </label>
          <button type="submit">Create</button>
        </form>
      </section>

      <section>
        <h2>Amend a requirement</h2>
        <form method="post" action="/editor/amend">
          <label>
            Requirement id
            <input type="text" name="id" placeholder="BILLING-002" required />
          </label>
          <label>
            New statement
            <textarea name="statement" rows="3"></textarea>
          </label>
          <label>
            New why (optional)
            <textarea name="why" rows="2"></textarea>
          </label>
          <button type="submit">Amend</button>
        </form>
      </section>
    `;
    return c.html(page("Editor", body));
  });

  app.post("/editor/create", editorBodyLimit, async (c) => {
    // Hiding the form does not turn the feature off; the endpoints check the flag too.
    if (!featureEnabled("editor")) return c.html(rejectPage(featureDisabledMessage("editor")), 404);
    if (crossOriginRejected(c, bindHost))
      return c.html(rejectPage("cross-origin request rejected"), 403);
    const form = (await c.req.parseBody()) as Record<string, unknown>;
    const statement = field(form, "statement");
    const why = field(form, "why");
    const relates = field(form, "relates");

    // `statement` passes through even when empty so the engine validator rejects
    // it. Blank optional fields are omitted so the engine applies the CLI's defaults.
    const payload: Record<string, unknown> = {
      key: field(form, "key"),
      statement,
    };
    if (why.length > 0) payload.why = why;
    if (relates.length > 0) payload.relates = relates;

    const res = await app.request("/api/requirements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return c.html(await renderResult(res));
  });

  app.post("/editor/amend", editorBodyLimit, async (c) => {
    if (!featureEnabled("editor")) return c.html(rejectPage(featureDisabledMessage("editor")), 404);
    if (crossOriginRejected(c, bindHost))
      return c.html(rejectPage("cross-origin request rejected"), 403);
    const form = (await c.req.parseBody()) as Record<string, unknown>;
    const id = field(form, "id");
    const statement = field(form, "statement");
    const why = field(form, "why");

    // Blank fields are omitted so they stay byte-identical; an all-blank submit
    // gets the engine's 400 unchanged.
    const payload: Record<string, unknown> = {};
    if (statement.length > 0) payload.statement = statement;
    if (why.length > 0) payload.why = why;

    const res = await app.request(`/api/requirements/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return c.html(await renderResult(res));
  });
}
