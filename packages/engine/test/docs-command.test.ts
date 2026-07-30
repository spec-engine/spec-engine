// packages/engine/test/docs-command.test.ts
//
// `spec docs` unit surface: the static-file handler (routing order,
// containment, 404 fallback) and the docs-root fallback chain. The handler
// is exercised directly via Request/Response — no port binding — so the
// suite stays hermetic; the end-to-end boot path is `spec docs --probe`
// (CI smoke territory, same division as serve.ts's SERV-04 probe).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createDocsFetchHandler,
  exitNoDocsRoot,
  resolveDocsRootFrom,
  runProbe,
} from "../src/commands/docs";

// ── fixture docs tree (Astro "directory" build shape) ───────────────────────
const root = mkdtempSync(join(tmpdir(), "spec-docs-"));
writeFileSync(join(root, "index.html"), "<title>Spec Engine</title> docs home");
writeFileSync(join(root, "404.html"), "custom not-found page");
mkdirSync(join(root, "guides", "start"), { recursive: true });
writeFileSync(join(root, "guides", "start", "index.html"), "start guide");
writeFileSync(join(root, "guides", "flat.html"), "flat page");
mkdirSync(join(root, "_astro"), { recursive: true });
writeFileSync(join(root, "_astro", "app.css"), "body{color:red}");
// A real file OUTSIDE the docs root — the traversal tests must prove this
// exact file cannot be reached through the handler.
const secretPath = `${root}-secret.txt`;
writeFileSync(secretPath, "outside the root");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(secretPath, { force: true });
});

const handler = createDocsFetchHandler(root);
const get = (path: string) => handler(new Request(`http://127.0.0.1${path}`));

describe("createDocsFetchHandler routing", () => {
  test("serves the site index at /", async () => {
    // @spec DIST-005 unit
    const res = get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("docs home");
  });

  test("serves directory pages with and without the trailing slash", async () => {
    for (const path of ["/guides/start/", "/guides/start"]) {
      const res = get(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("start guide");
    }
  });

  test("serves <path>.html for extensionless page requests", async () => {
    const res = get("/guides/flat");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("flat page");
  });

  test("serves assets with an extension-derived content type", async () => {
    const res = get("/_astro/app.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("css");
  });

  test("missing pages fall back to the site's own 404.html with status 404", async () => {
    const res = get("/nope/never/");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("custom not-found page");
  });

  test("encoded traversal cannot escape the docs root", async () => {
    // Plain `/../` is already normalized away by the URL parser; the encoded
    // form survives into pathname and must be contained by the handler.
    const res = get(`/%2e%2e/${encodeURIComponent(`${root.split("/").pop()}-secret.txt`)}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("outside the root");
  });

  test("null bytes and undecodable escapes are 400, not a crash", () => {
    expect(get("/%00").status).toBe(400);
    expect(get("/%zz").status).toBe(400);
  });
});

describe("resolveDocsRootFrom fallback chain", () => {
  test("first candidate holding an index.html wins", () => {
    // @spec DIST-007 unit
    const empty = mkdtempSync(join(tmpdir(), "spec-docs-empty-"));
    try {
      expect(resolveDocsRootFrom([empty, root])).toBe(root);
      expect(resolveDocsRootFrom([root, empty])).toBe(root);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("no candidate with an index.html resolves to null", () => {
    const empty = mkdtempSync(join(tmpdir(), "spec-docs-empty-"));
    try {
      expect(resolveDocsRootFrom([empty, join(empty, "missing")])).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("docs --probe / missing-root exits", () => {
  function withExitCapture(fn: () => Promise<void> | void): Promise<number | null> {
    const originalExit = process.exit;
    const originalLog = console.log;
    const originalErr = console.error;
    class ExitError extends Error {
      constructor(public code: number) {
        super(`process.exit(${code})`);
      }
    }
    (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
      throw new ExitError(code ?? 0);
    };
    console.log = () => {};
    console.error = () => {};
    return Promise.resolve()
      .then(fn)
      .then(
        () => null,
        (e) => {
          if (e instanceof ExitError) return e.code;
          throw e;
        },
      )
      .finally(() => {
        process.exit = originalExit;
        console.log = originalLog;
        console.error = originalErr;
      });
  }

  test("--probe: ephemeral loopback boot, GET /, exit 0 when the title renders", async () => {
    // @spec DIST-006 unit
    expect(await withExitCapture(() => runProbe(root))).toBe(0);
  });

  test("--probe: exit 1 when the served index lacks the site title", async () => {
    // @spec DIST-006 unit
    const bad = mkdtempSync(join(tmpdir(), "spec-docs-bad-"));
    try {
      writeFileSync(join(bad, "index.html"), "<title>Not the site</title>");
      expect(await withExitCapture(() => runProbe(bad))).toBe(1);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });

  test("no docs root: exit 2 naming `bun run build:site`", async () => {
    // @spec DIST-008 unit
    expect(await withExitCapture(() => exitNoDocsRoot())).toBe(2);
    // withExitCapture silences console.error, so assert the guidance at the
    // source level: the message names the build command.
    const src = readFileSync(resolve(import.meta.dir, "..", "src", "commands", "docs.ts"), "utf8");
    expect(src).toContain("bun run build:site");
  });
});

describe("docs.ts loopback fence (same posture as test/serve-loopback.test.ts)", () => {
  test("the all-zeros bind address never appears; every serve site is 127.0.0.1", () => {
    // @spec DIST-005 unit
    const src = readFileSync(resolve(import.meta.dir, "..", "src", "commands", "docs.ts"), "utf8");
    expect(src).not.toContain("0.0.0.0");
    const hostnames = [...src.matchAll(/hostname:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(hostnames.length).toBeGreaterThan(0);
    for (const h of hostnames) expect(h).toBe("127.0.0.1");
    // No host/bind arg may ever be REGISTERED (comments may mention the
    // policy; an args-block key would be a real surface).
    expect(src).not.toMatch(/^\s+(host|hostname|bind):\s*\{/m);
  });
});
