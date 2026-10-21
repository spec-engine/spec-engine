// `createApp()` is otherwise exercised only by the compiled-binary probe smoke.

import { describe, expect, test } from "bun:test";
import { createApp, placeholderHtml } from "./server";

describe("createApp", () => {
  test("GET / → 200 with the embedded placeholder HTML", async () => {
    const app = createApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Spec Engine — coming online");
    expect(body).toBe(placeholderHtml);
  });

  test("unknown route → 404 (no surprise catch-all)", async () => {
    const app = createApp();
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });
});
