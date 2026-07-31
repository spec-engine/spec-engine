// packages/engine/test/feature-flags.test.ts
//
// The shared feature-flag system (shared/flags.ts, D4a decided 2026-07-30).
// Every coming-soon feature sits behind one flag map; all default OFF. The
// rule with teeth: off means the ROUTES are off, not just the nav link —
// before this system the Editor was "coming soon" in the nav while its write
// endpoints were live.
//
//   - SPEC_FLAGS is the local override (comma-separated keys; unknown keys
//     ignored).
//   - Off: nav shows "coming soon", the page serves the coming-soon document,
//     write endpoints answer 404 with a message naming the flag.
//   - On: nav links, page serves, endpoints work.
//
// Verifies:
// @spec SERV-006 integration
// @spec SERV-007 integration

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFlags, type Storage } from "@spec-engine/shared";
import { composeServeApp } from "../src/commands/serve";
import { openStorage } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let platformDir: string;
let storage: Storage;
let app: ReturnType<typeof composeServeApp>;
let priorFlags: string | undefined;

beforeEach(() => {
  priorFlags = process.env.SPEC_FLAGS;
  delete process.env.SPEC_FLAGS;
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

describe("parseFlags — the SPEC_FLAGS grammar", () => {
  test("comma-separated keys enable; whitespace and case are forgiven; unknown keys are ignored", () => {
    const flags = parseFlags(" Editor , query, nonsense ,");
    expect(flags.has("editor")).toBe(true);
    expect(flags.has("query")).toBe(true);
    expect(flags.size).toBe(2);
  });

  test("absent/empty means everything off", () => {
    expect(parseFlags(undefined).size).toBe(0);
    expect(parseFlags("").size).toBe(0);
  });
});

describe("flag off — routes are off, not just the nav link", () => {
  test("the editor page serves the coming-soon document", async () => {
    const res = await app.request("/editor");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Coming soon");
  });

  test("the API write endpoints answer 404 naming the flag", async () => {
    const post = await app.request("/api/requirements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "BILLING", statement: "flag-off write attempt" }),
    });
    expect(post.status).toBe(404);
    expect(((await post.json()) as { error: string }).error).toContain("SPEC_FLAGS=editor");

    const put = await app.request("/api/requirements/BILLING-002", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "flag-off amend attempt" }),
    });
    expect(put.status).toBe(404);
  });

  // @spec SERV-006 integration
  test("the flagged READ endpoints answer 404 too — every surface, not just the write plane", async () => {
    const cases: Array<[string, string]> = [
      ["/api/query?q=renewal", "query"],
      ["/api/relations", "relations"],
      ["/api/provenance", "provenance"],
      ["/api/provenance/by-issue?issue=RED-1", "provenance"],
    ];
    for (const [path, key] of cases) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toContain(`SPEC_FLAGS=${key}`);
    }
  });

  test("the nav renders the feature as coming soon, not a link", async () => {
    const res = await app.request("/");
    const body = await res.text();
    expect(body).toContain("coming soon");
    expect(body).not.toContain('href="/editor"');
  });
});

describe("flag on — the same surfaces work", () => {
  test("SPEC_FLAGS=editor turns on the page, the endpoints, and the nav link", async () => {
    process.env.SPEC_FLAGS = "editor";
    const page = await app.request("/editor");
    expect(await page.text()).toContain('action="/editor/create"');

    const post = await app.request("/api/requirements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "BILLING", statement: "flag-on write" }),
    });
    expect(post.status).toBe(201);

    const nav = await app.request("/");
    expect(await nav.text()).toContain('href="/editor"');
  });

  // @spec SERV-006 integration
  test("SPEC_FLAGS on: the read endpoints answer 200 again", async () => {
    process.env.SPEC_FLAGS = "query,relations,provenance";
    expect((await app.request("/api/query?q=renewal")).status).toBe(200);
    expect((await app.request("/api/relations")).status).toBe(200);
    expect((await app.request("/api/provenance")).status).toBe(200);
  });

  test("SPEC_FLAGS=query serves the real query page instead of the stub", async () => {
    process.env.SPEC_FLAGS = "query";
    const res = await app.request("/query");
    const body = await res.text();
    expect(body).not.toContain("Coming soon");
  });
});
