// The editor forwards every write in-process via `app.request()`, never
// `fetch`, and does not re-validate or touch the filesystem. Test-only engine
// imports are allowed: see import-fence.test.ts and the webapp biome.json.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { composeServeApp } from "@spec-engine/spec-engine/src/commands/serve";
import { openStorage } from "@spec-engine/spec-engine/src/storage/sqlite";
import { commitAndTag } from "@spec-engine/spec-engine/src/testing/git";
import { cloneFixture } from "./testing/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let platformDir: string;
let storage: Storage;
let app: ReturnType<typeof composeServeApp>;

let priorFlags: string | undefined;

beforeEach(() => {
  // The editor ships behind the shared feature flag; these tests exercise the
  // enabled behavior. Default-off behavior is covered in feature-flags.test.ts.
  priorFlags = process.env.SPEC_FLAGS;
  process.env.SPEC_FLAGS = "editor";
  platformDir = cloneFixture(FIXTURE);
  storage = openStorage(join(platformDir, ".spec-engine", "test-index.sqlite"));
  app = composeServeApp(storage, platformDir);
});

afterEach(() => {
  if (priorFlags === undefined) delete process.env.SPEC_FLAGS;
  else process.env.SPEC_FLAGS = priorFlags;
  storage.close();
  rmSync(platformDir, { recursive: true, force: true });
});

function billingSpecPath(): string {
  return join(platformDir, "spec-engine", "BILLING", "SPEC.json");
}

/** Mirrors a browser <form> post. */
async function postForm(path: string, fields: Record<string, string>): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("webapp editor — body cap enforced on actual bytes (bodyLimit)", () => {
  test("an oversized streamed body (no honest Content-Length) is rejected 413", async () => {
    // A streamed body carries no Content-Length, so only actual-byte counting
    // can reject it; a header-only check is bypassed.
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
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });
});

describe("webapp editor — the create form forwards to POST /api/requirements", () => {
  test("GET /editor renders both a create and an amend form", async () => {
    const res = await app.request("/editor");
    expect(res.status).toBe(200);
    const bodyHtml = await res.text();
    expect(bodyHtml).toContain('action="/editor/create"');
    expect(bodyHtml).toContain('action="/editor/amend"');
    // The form must never expose a network base URL — the forward is in-process.
    expect(bodyHtml).not.toContain('fetch("http');
  });

  test("a create submit reports success with the new id and the requirement is queryable", async () => {
    const res = await postForm("/editor/create", {
      key: "BILLING",
      statement: "When a refund is issued, reverse the tax collected on the charge.",
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
    expect(added?.text).toBe("When a refund is issued, reverse the tax collected on the charge.");
  });

  // @spec REQ-083 integration
  test("a create submit that repeats an Active statement saves and names the possible duplicate", async () => {
    const res = await postForm("/editor/create", {
      key: "BILLING",
      statement: "When a charge fails, retry on a schedule and notify the customer by email.",
    });
    expect(res.status).toBe(200);
    const bodyHtml = await res.text();
    expect(bodyHtml).toContain("BILLING-010");
    expect(bodyHtml).toContain("Possible duplicate of");
    expect(bodyHtml).toContain('<a href="/requirements/BILLING-002"><code>BILLING-002</code></a>');
  });
});

describe("webapp editor — the amend form forwards to PUT /api/requirements/:id", () => {
  // AUTH-001 is the fixture's Active-but-unbound requirement — the only kind
  // the engine's amend gate lets through (a shipped or superseded entry is 409).
  test("an amend submit updates the statement and a re-GET reflects it", async () => {
    const res = await postForm("/editor/amend", {
      id: "AUTH-001",
      statement: "When a session is idle for 30 days, the system shall expire it.",
    });
    expect(res.status).toBe(200);
    const bodyHtml = await res.text();
    expect(bodyHtml).toContain("AUTH-001");

    const getRes = await app.request("/api/requirements/AUTH-001");
    expect(getRes.status).toBe(200);
    const row = (await getRes.json()) as { text: string };
    expect(row.text).toBe("When a session is idle for 30 days, the system shall expire it.");
  });

  test("an amend submit for a released requirement renders the engine's refusal, not a save", async () => {
    commitAndTag(platformDir, "v1.0.0");
    const res = await postForm("/editor/amend", {
      id: "BILLING-002",
      statement: "Editing a shipped requirement in place.",
    });
    expect(res.status).toBe(200);
    const bodyHtml = await res.text();
    expect(bodyHtml).toContain("Not saved");
    expect(bodyHtml).toContain("supersede");
  });
});

describe("webapp editor — the browser-facing routes reject a cross-site POST", () => {
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

  test("a DNS-rebound POST (non-loopback Host, matching Origin) is rejected 403", async () => {
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

describe("webapp editor — invalid input surfaces the engine diagnostic unchanged", () => {
  test("an empty statement renders INVALID_DOMAIN_FILE and does not mutate the SPEC.json", async () => {
    const onDiskBefore = readFileSync(billingSpecPath(), "utf8");
    const res = await postForm("/editor/create", {
      key: "BILLING",
      statement: "",
    });
    const bodyHtml = await res.text();
    // Surfaced unchanged: the webapp does not re-validate.
    expect(bodyHtml).toContain("INVALID_DOMAIN_FILE");
    // The rejected write left the canonical JSON byte-identical.
    expect(readFileSync(billingSpecPath(), "utf8")).toBe(onDiskBefore);
  });
});
