// packages/webapp/test/create-app.test.ts
//
// RED-14 dead-end audit: `createApp()` (the Phase 1 probe factory that
// `spec serve --probe` binds) was only exercised by the CI smoke against
// the compiled binary, never by `bun test`. Lock its two contracts here:
// `/` serves the embedded placeholder HTML, and the export `placeholderHtml`
// is the same string the route returns (the D-14 inline-embedding proof
// the probe smoke asserts end-to-end).

import { describe, expect, test } from "bun:test";
import { createApp, placeholderHtml } from "../src/server";

describe("createApp (Phase 1 probe factory)", () => {
  test("GET / → 200 with the embedded placeholder HTML", async () => {
    const app = createApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("spec-check — coming online");
    expect(body).toBe(placeholderHtml);
  });

  test("unknown route → 404 (no surprise catch-all)", async () => {
    const app = createApp();
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });
});
