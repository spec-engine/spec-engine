// @spec SERV-019
// @spec SERV-023
//
// The all-zeros address must never appear in this file: serve.test.ts greps
// for it as the guard against a wildcard bind.
//
// Storage lifecycle: real-serve mode keeps storage open for the process
// lifetime; there is deliberately no try/finally close around the Bun.serve
// bind. SIGINT terminates the process and Bun closes the file descriptor.

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_BIND_HOST, type Storage } from "@spec-engine/shared";
import { createApp, mountWebapp } from "@spec-engine/webapp/server";
import { defineCommand } from "citty";
import { Hono } from "hono";
import { EXIT, OUT_HELP, resolveDbPath } from "../constants";
import { assertSpecPlatform, platformName } from "../indexer/discover";
import { runIndex } from "../indexer/pipeline";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { mountApi } from "../server/api";
import {
  bindHostRefusal,
  generateToken,
  isLoopbackAddress,
  type LanGateOptions,
  lanGate,
  pinnedTokenRefusal,
  urlHost,
} from "../server/lan";
import { openStorage } from "../storage/sqlite";
import { platformDirArg, resolvePlatformDir } from "./_args";
import {
  assertContainedPath,
  handleInvalidDomainFiles,
  handleNotAPlatform,
  handleStorageUnavailable,
} from "./_shared";

/**
 * Exported so tests can compose the app without citty's `run`, which blocks
 * on Bun.serve.
 *
 * Deliberately not `createApp()` (the probe factory): that one already
 * registers `/` with the placeholder, which `mountWebapp` would conflict with.
 *
 * `platformDir` reaches `mountApi` so `/api/provenance?resolve=1` writes its
 * tracker sidecar under `<platformDir>/.spec-engine/`.
 */
export function composeServeApp(
  storage: Storage,
  platformDir: string = process.cwd(),
  bindHost: string = DEFAULT_BIND_HOST,
): Hono {
  const app = new Hono();
  mountApi(app, storage, platformDir, bindHost);
  mountWebapp(app, bindHost, platformName(platformDir));
  return app;
}

function usageError(message: string): never {
  console.error(`spec serve: ${message}`);
  process.exit(EXIT.USAGE);
}

export function resolveBind(args: {
  host?: string | undefined;
  token?: string | undefined;
  allowWrites?: boolean | undefined;
}): { host: string; lan: LanGateOptions | null } {
  const host = args.host ?? DEFAULT_BIND_HOST;
  const hostRefusal = bindHostRefusal(host);
  if (hostRefusal !== null) usageError(hostRefusal);
  if (isLoopbackAddress(host)) return { host, lan: null };

  const pinned = args.token ?? process.env.SPEC_SERVE_TOKEN;
  if (pinned !== undefined) {
    const tokenRefusal = pinnedTokenRefusal(pinned);
    if (tokenRefusal !== null) usageError(tokenRefusal);
  }
  return {
    host,
    lan: {
      bindHost: host,
      token: pinned ?? generateToken(),
      allowWrites: args.allowWrites === true,
    },
  };
}

/**
 * Extracted from `run` so the real-serve branch stays under the biome
 * cognitive-complexity ceiling; the two modes share no state.
 *
 * @spec SERV-011
 * @spec SERV-012
 */
async function runProbe(): Promise<void> {
  const app = createApp();
  // SECURITY: hardcoded loopback. Do not take a --host arg; the probe lives
  // only on the developer's own machine.
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: app.fetch,
  });

  // The success-path exit lives below the try/catch: inside it, a
  // process.exit that throws (the ExitError test stub) would be swallowed
  // and re-raised as exit 1. Only the fetch/assert work is guarded.
  try {
    const url = `http://127.0.0.1:${server.port}/`;
    const res = await fetch(url);
    if (res.status !== 200) {
      console.error(`serve --probe FAILED: status was ${res.status}, expected 200`);
      server.stop();
      process.exit(EXIT.FAILURE);
    }
    const body = await res.text();
    if (!body.includes("Spec Engine — coming online")) {
      console.error(`serve --probe FAILED: body did not contain the placeholder string`);
      server.stop();
      process.exit(EXIT.FAILURE);
    }
  } catch (err) {
    console.error("serve --probe FAILED:", err);
    server.stop();
    process.exit(EXIT.FAILURE);
  }
  console.log("serve --probe OK");
  server.stop();
  process.exit(EXIT.OK);
}

export const serveCommand = defineCommand({
  meta: {
    name: "serve",
    description:
      "Run the local webapp. Binds 127.0.0.1 on --port, or one private --host address behind an access token. --probe is the asset-embedding smoke.",
  },
  args: {
    platformDir: platformDirArg,
    port: {
      type: "string",
      default: "4000",
      description: "Port (default 4000; 0 = ephemeral).",
    },
    host: {
      type: "string",
      default: DEFAULT_BIND_HOST,
      description:
        "Address to bind (default 127.0.0.1). Only a literal loopback, RFC 1918, or 100.64.0.0/10 IP; a non-loopback address requires the printed access token and is read-only.",
    },
    token: {
      type: "string",
      description:
        "Pin the access token for a non-loopback --host (else SPEC_SERVE_TOKEN, else random). At least 16 of A-Z a-z 0-9 _ -.",
    },
    allowWrites: {
      type: "boolean",
      description: "On a non-loopback --host, permit editor writes and tracker resolution.",
    },
    out: {
      type: "string",
      description: OUT_HELP,
    },
    probe: {
      type: "boolean",
      description:
        "Smoke test: bind ephemeral port on 127.0.0.1 (ignores --host), GET /, assert body contains placeholder, exit.",
    },
    noPrompt: {
      type: "boolean",
      description:
        "Suppress interactive onboarding prompt for siblings missing spec-engine.member.json (defaults to NO_SPEC_CONFIG warning)",
    },
  },
  async run({ args }) {
    if (args.probe) {
      await runProbe();
      return;
    }

    const rawPort = args.port ?? "0";
    if (!/^[0-9]+$/.test(rawPort)) {
      console.error("spec serve: --port must be an integer 0..65535");
      process.exit(EXIT.USAGE);
      return;
    }
    const port = Number.parseInt(rawPort, 10);
    if (port > 65535) {
      console.error("spec serve: --port must be an integer 0..65535");
      process.exit(EXIT.USAGE);
      return;
    }

    const { host, lan } = resolveBind(args);

    const platformDir = resolvePlatformDir(args);
    const outArg = args.out;
    const dbPath = resolveDbPath(platformDir, outArg);
    if (outArg) assertContainedPath(dbPath, platformDir, "spec serve: --out");

    // Must run before mkdirSync/openStorage: otherwise runIndex's
    // NotASpecPlatformError surfaces as the generic "failed to start", and a
    // stale `.spec-engine/` is left behind to serve an empty index next time.
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    // Runs after the --probe branch returns (the probe never prompts) and
    // before mkdirSync(.spec-engine), so declining leaves no artefacts. No
    // `ci` arg: only `check` registers `--ci`.
    await maybePromptForOnboarding({
      platformDir,
      args: {
        noPrompt: args.noPrompt,
      },
    });

    mkdirSync(dirname(dbPath), { recursive: true });

    // Captured before openStorage, which creates the file on demand.
    const needsIndex = !existsSync(dbPath);
    // Fail-fast diagnosis: openStorage takes the WAL locks, so a sandboxed
    // process (file locks denied → SQLITE_IOERR_VNODE) dies HERE with the
    // actionable one-liner instead of binding the port and 500ing on every
    // later request.
    let storage: Storage;
    try {
      storage = openStorage(dbPath);
    } catch (err) {
      handleStorageUnavailable(err, dbPath);
      throw err;
    }

    // If runIndex or Bun.serve throws, close storage so WAL siblings are
    // flushed before exit. Once Bun.serve returns, storage belongs to the
    // server's process lifetime and is intentionally not closed.
    let server: ReturnType<typeof Bun.serve>;
    try {
      if (needsIndex || storage.listRepos().length === 0) {
        // The second disjunct catches the silent-rebuild case: the DB file
        // existed (so needsIndex is false) but openStorage wiped it because
        // its _schema_version predated a SCHEMA_VERSION bump. An indexed
        // platform always has >= 1 repo row (the canonical), so an empty
        // repos table means "no index here"; without this, every read serves
        // empty output until someone runs `spec index`.
        await runIndex({ platformDir, storage });
      }

      const app = composeServeApp(storage, platformDir, host);
      server = Bun.serve({
        port,
        hostname: host,
        fetch: lan === null ? app.fetch : lanGate(app.fetch, lan),
      });
    } catch (err) {
      storage.close();
      handleInvalidDomainFiles(err, false);
      handleStorageUnavailable(err, dbPath);
      console.error(`spec serve: failed to start on ${urlHost(host, port)}:`, err);
      process.exit(EXIT.FAILURE);
      // `process.exit` is typed `never`, but a test stub that records exits
      // without throwing would reach the unset `server` below.
      return;
    }

    // Do not close storage here: the server outlives this run() call.
    const serving = `spec: serving ${platformName(platformDir)} on ${server.url.origin}`;
    if (lan === null) {
      console.log(serving);
      return;
    }
    console.log(`${serving}/?token=${lan.token}`);
    console.log(lan.allowWrites ? "spec: writes ALLOWED (--allow-writes)" : "spec: read-only");
  },
});
