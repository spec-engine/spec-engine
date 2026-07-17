// packages/webapp/test/write-path.test.ts
//
// VAL-03 (21-04): the webapp gains a THIN SSR editor over the engine write
// route from plan 21-01. `packages/webapp/src/pages/editor.ts` renders a
// create form and an amend form and, on submit, forwards the fields to the
// engine's `POST /api/requirements` / `PUT /api/requirements/:id` routes
// IN-PROCESS via `app.request()` (Pitfall 6 — NEVER `fetch("http://…")`).
// The webapp does NOT re-validate, does NOT touch the filesystem, and does
// NOT fork any write logic — every property below is a boundary assertion
// over the ONE engine seam:
//
//   (1) CREATE — POST the editor's create endpoint with form-encoded fields
//       → the rendered result reports success and carries the new id, and a
//       follow-up GET /api/requirements?key= shows the requirement with the
//       submitted statement.
//   (2) AMEND — POST the editor's amend endpoint for an existing id with a
//       new statement → success; a re-GET reflects the new statement.
//   (3) INVALID PARITY — submit an empty statement → the rendered page
//       contains the engine's INVALID_DOMAIN_FILE diagnostic (surfaced
//       unchanged) and the canonical SPEC.json is NOT mutated.
//
// Everything is driven in-process through `composeServeApp` + `app.request()`
// (no port bind, no network fetch). TEST-ONLY engine imports are permitted —
// the D-09 import fence scopes to `packages/webapp/src/**` only (see
// import-fence.test.ts + biome.json). Harness mirrors
// `packages/engine/test/server-write.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { composeServeApp } from "@spec-engine/spec-engine/src/commands/serve";
import { openStorage } from "@spec-engine/spec-engine/src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let platformDir: string;
let storage: Storage;
let app: ReturnType<typeof composeServeApp>;

beforeEach(() => {
  platformDir = cloneFixture(FIXTURE);
  storage = openStorage(join(platformDir, ".spec-engine", "test-index.sqlite"));
  app = composeServeApp(storage, platformDir);
});

afterEach(() => {
  storage.close();
  rmSync(platformDir, { recursive: true, force: true });
});

function billingSpecPath(): string {
  return join(platformDir, "spec-engine", "BILLING", "SPEC.json");
}

/** Post a form-encoded body to a webapp endpoint (mirrors a browser <form>). */
function postForm(path: string, fields: Record<string, string>): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("2.6 webapp editor — body cap enforced on actual bytes (bodyLimit)", () => {
  test("an oversized streamed body (no honest Content-Length) is rejected 413", async () => {
    // The header-only check the bodyLimit middleware replaces let a request with
    // an absent/streamed Content-Length bypass the cap. A >64 KiB streamed body
    // carries no Content-Length, so only actual-byte counting can reject it.
    const huge = "x".repeat(70 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(huge));
        controller.close();
      },
    });
    const res = await app.request("http://localhost/editor/create", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: stream,
      // @ts-expect-error — a stream body requires `duplex` (not in the RequestInit types)
      duplex: "half",
    });
    expect(res.status).toBe(413);
  });
});

describe("VAL-03 webapp editor — the create form forwards to POST /api/requirements", () => {
  test("GET /editor renders both a create and an amend form", async () => {
    const res = await app.request("/editor");
    expect(res.status).toBe(200);
    const bodyHtml = await res.text();
    // Two forms that post to the editor's create + amend endpoints.
    expect(bodyHtml).toContain('action="/editor/create"');
    expect(bodyHtml).toContain('action="/editor/amend"');
    // The form must never expose a network base URL — the forward is in-process.
    expect(bodyHtml).not.toContain('fetch("http');
  });

  test("a create submit reports success with the new id and the requirement is queryable", async () => {
    const res = await postForm("/editor/create", {
      key: "BILLING",
      statement: "When a refund is issued, reverse the tax previously collected.",
      why: "Refund correctness.",
    });
    expect(res.status).toBe(200);
    const bodyHtml = await res.text();
    // BILLING already holds seq 1,2,7,9 → next is 010.
    expect(bodyHtml).toContain("BILLING-010");

    const getRes = await app.request("/api/requirements?key=BILLING");
    expect(getRes.status).toBe(200);
    const rows = (await getRes.json()) as Array<{ id: string; text: string; status: string }>;
    const added = rows.find((r) => r.id === "BILLING-010");
    expect(added).toBeDefined();
    expect(added?.text).toBe("When a refund is issued, reverse the tax previously collected.");
  });
});

describe("VAL-03 webapp editor — the amend form forwards to PUT /api/requirements/:id", () => {
  test("an amend submit updates the statement and a re-GET reflects it", async () => {
    const res = await postForm("/editor/amend", {
      id: "BILLING-002",
      statement: "When a charge fails, retry with exponential backoff and notify the customer.",
    });
    expect(res.status).toBe(200);
    const bodyHtml = await res.text();
    expect(bodyHtml).toContain("BILLING-002");

    const getRes = await app.request("/api/requirements/BILLING-002");
    expect(getRes.status).toBe(200);
    const row = (await getRes.json()) as { text: string };
    expect(row.text).toBe(
      "When a charge fails, retry with exponential backoff and notify the customer.",
    );
  });
});

describe("CR-01 webapp editor — the browser-facing routes reject a cross-site POST", () => {
  test("a cross-origin POST to /editor/create is rejected 403 and does NOT mutate the SPEC.json", async () => {
    const onDiskBefore = readFileSync(billingSpecPath(), "utf8");
    const res = await app.request("/editor/create", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // A drive-by page on another origin auto-submitting a form.
        origin: "http://evil.example",
      },
      body: new URLSearchParams({ key: "BILLING", statement: "malicious" }).toString(),
    });
    expect(res.status).toBe(403);
    // The rejected cross-site write left the canonical JSON byte-identical.
    expect(readFileSync(billingSpecPath(), "utf8")).toBe(onDiskBefore);
  });

  test("a cross-origin POST to /editor/amend is rejected 403", async () => {
    const res = await app.request("/editor/amend", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://evil.example",
      },
      body: new URLSearchParams({ id: "BILLING-002", statement: "malicious" }).toString(),
    });
    expect(res.status).toBe(403);
  });

  test("a same-origin form post (Origin host matches) is allowed through", async () => {
    // app.request uses a http://localhost base; a matching Origin is same-origin.
    const res = await app.request("/editor/create", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
      },
      body: new URLSearchParams({
        key: "BILLING",
        statement: "When a same-origin edit lands, it is allowed.",
      }).toString(),
    });
    // Not a 403 — the same-origin post reaches the engine (200 success page).
    expect(res.status).toBe(200);
  });

  test("1.1 a DNS-rebound POST (non-loopback Host, matching Origin) is rejected 403", async () => {
    // The attacker page on evil.example resolves to 127.0.0.1, so its Origin
    // and Host agree — the same-origin check passes. The Host pin rejects it
    // because evil.example is not a loopback name.
    const onDiskBefore = readFileSync(billingSpecPath(), "utf8");
    const res = await app.request("http://evil.example/editor/create", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://evil.example",
      },
      body: new URLSearchParams({ key: "BILLING", statement: "rebound" }).toString(),
    });
    expect(res.status).toBe(403);
    expect(readFileSync(billingSpecPath(), "utf8")).toBe(onDiskBefore);
  });
});

describe("VAL-03 webapp editor — invalid input surfaces the engine diagnostic unchanged (VAL-02)", () => {
  test("an empty statement renders INVALID_DOMAIN_FILE and does not mutate the SPEC.json", async () => {
    const onDiskBefore = readFileSync(billingSpecPath(), "utf8");
    const res = await postForm("/editor/create", {
      key: "BILLING",
      statement: "",
    });
    const bodyHtml = await res.text();
    // The engine's structured diagnostic is surfaced to the user unchanged
    // (one engine — the webapp does not re-validate).
    expect(bodyHtml).toContain("INVALID_DOMAIN_FILE");
    // The rejected write left the canonical JSON byte-identical.
    expect(readFileSync(billingSpecPath(), "utf8")).toBe(onDiskBefore);
  });
});
