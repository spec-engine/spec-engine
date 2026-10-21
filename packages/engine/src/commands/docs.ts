// @spec DIST-005
// @spec DIST-006
// @spec DIST-007
// @spec DIST-008
//
// Asset paths resolve from import.meta.url, never cwd: the CLI runs from any
// directory, which is why Hono's cwd-rooted serveStatic is not used here.

import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand } from "citty";
import { EXIT } from "../constants";

/**
 * Split from `resolveDocsRoot` so tests can drive the fallback order with
 * temp dirs instead of depending on whether this machine has built the site.
 */
export function resolveDocsRootFrom(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

/**
 * The real candidate chain, npm payload first:
 *   - `docs/` beside the running module — dist/impl.js → dist/docs/ in the
 *     published package (src/commands/docs/ never exists in a checkout, so
 *     this can't false-positive there);
 *   - `packages/site/dist` relative to this source file in a checkout.
 */
export function resolveDocsRoot(): string | null {
  return resolveDocsRootFrom([
    fileURLToPath(new URL("docs/", import.meta.url)),
    fileURLToPath(new URL("../../../site/dist/", import.meta.url)),
  ]);
}

/**
 * Static-file handler over one docs root. Serves, in order: the exact file,
 * the directory index (`<path>/index.html` — Astro's default "directory"
 * build format), then `<path>.html`. Anything else falls to the site's own
 * 404.html (status 404) or a plain 404. Content types come from Bun.file's
 * extension mapping.
 */
export function createDocsFetchHandler(root: string): (req: Request) => Response {
  const normalRoot = normalize(root);
  const rootPrefix = normalRoot.endsWith(sep) ? normalRoot : normalRoot + sep;
  return (req: Request): Response => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (pathname.includes("\0")) {
      return new Response("Bad request", { status: 400 });
    }
    // Containment: normalize against the root; a traversal that escapes it
    // 404s — never leaks the filesystem outside the docs payload.
    const target = normalize(join(normalRoot, pathname));
    if (target !== normalRoot && !target.startsWith(rootPrefix)) {
      return new Response("Not found", { status: 404 });
    }
    for (const candidate of [target, join(target, "index.html"), `${target}.html`]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return new Response(Bun.file(candidate));
      }
    }
    const notFoundPage = join(normalRoot, "404.html");
    if (existsSync(notFoundPage)) {
      return new Response(Bun.file(notFoundPage), { status: 404 });
    }
    return new Response("Not found", { status: 404 });
  };
}

/**
 * The success exit stays below the try/catch, as in serve.ts's probe.
 * Exported so the unit suite can drive it against a temp docs root without
 * depending on a built site.
 * @spec DIST-006
 */
export async function runProbe(root: string): Promise<void> {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createDocsFetchHandler(root),
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    if (res.status !== 200) {
      console.error(`docs --probe FAILED: status was ${res.status}, expected 200`);
      server.stop();
      process.exit(EXIT.FAILURE);
    }
    const body = await res.text();
    if (!body.includes("Spec Engine")) {
      console.error("docs --probe FAILED: body did not contain the site title");
      server.stop();
      process.exit(EXIT.FAILURE);
    }
  } catch (err) {
    console.error("docs --probe FAILED:", err);
    server.stop();
    process.exit(EXIT.FAILURE);
  }
  console.log("docs --probe OK");
  server.stop();
  process.exit(EXIT.OK);
}

/**
 * Extracted so the unit suite can assert the exit code and guidance.
 * @spec DIST-008
 */
export function exitNoDocsRoot(): void {
  console.error(
    "spec docs: no built documentation found. From a checkout run `bun run build:site` " +
      "(writes packages/site/dist); the published npm package ships it at dist/docs.",
  );
  process.exit(EXIT.USAGE);
}

export const docsCommand = defineCommand({
  meta: {
    name: "docs",
    description:
      "Serve the bundled documentation site offline. Binds 127.0.0.1 on --port (loopback only — no --host). --probe is the boot-and-fetch smoke.",
  },
  args: {
    port: {
      type: "string",
      default: "4100",
      description:
        "Port (default 4100; 0 = ephemeral). Hostname is hardcoded 127.0.0.1; no --host accepted.",
    },
    probe: {
      type: "boolean",
      description:
        "Smoke test: bind ephemeral port on 127.0.0.1, GET /, assert the site title renders, exit.",
    },
  },
  async run({ args }) {
    const root = resolveDocsRoot();
    if (!root) {
      exitNoDocsRoot();
      return;
    }

    if (args.probe) {
      await runProbe(root);
      return;
    }

    const rawPort = args.port ?? "0";
    if (!/^[0-9]+$/.test(rawPort)) {
      console.error("spec docs: --port must be an integer 0..65535");
      process.exit(EXIT.USAGE);
      return;
    }
    const port = Number.parseInt(rawPort, 10);
    if (port > 65535) {
      console.error("spec docs: --port must be an integer 0..65535");
      process.exit(EXIT.USAGE);
      return;
    }

    let server: ReturnType<typeof Bun.serve>;
    try {
      // SECURITY: hardcoded loopback; there is deliberately no --host.
      server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: createDocsFetchHandler(root),
      });
    } catch (err) {
      console.error(`spec docs: failed to start on 127.0.0.1:${port}:`, err);
      process.exit(EXIT.FAILURE);
      return;
    }
    console.log(`spec: docs on http://127.0.0.1:${server.port}`);
  },
});
