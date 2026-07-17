// packages/engine/test/serve-loopback.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec SERV-001
//
// Plan 05-05 / Task 1 — locks SERV-01 at the CLI surface and the
// loopback-only invariant for `spec serve`.
//
// Three test families:
//   1. SOURCE-GREP tests over `packages/engine/src/commands/serve.ts`:
//        a. `hostname: "127.0.0.1"` appears ≥ 2 times (probe + real serve).
//        b. The substring `0.0.0.0` never appears (case-sensitive).
//        c. No `--host` / `--hostname` / `--bind` arg name is declared
//           anywhere in the citty `args:` block.
//   2. REAL-SERVE in-process smoke: `composeServeApp(storage)` returns a
//      Hono that, bound on Bun.serve port 0 / 127.0.0.1, answers
//      `/api/coverage` with 200 (proves engine + webapp are composed).
//   3. CITTY ARGV validation: invoking the citty `run` handler with bad
//      --port and bad --out exits 2.
//
// The citty harness mirrors the ExitError pattern from
// cli-query-unit.test.ts so the test can assert exit codes without
// terminating the runner. Per-test cleanup uses `rmSync` against the
// per-test clone — never against `fixtures/platform-fixture/` (WR-06).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { composeServeApp, serveCommand } from "../src/commands/serve";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");
const SERVE_SRC = resolve(import.meta.dir, "..", "src", "commands", "serve.ts");

// ---------- ExitError harness (mirrors cli-query-unit.test.ts) ----------

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

let clone: string;
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

beforeEach(() => {
  clone = cloneFixture(FIXTURE);
  logs = [];
  errs = [];
  originalLog = console.log;
  originalErr = console.error;
  originalExit = process.exit;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new ExitError(code ?? 0);
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  rmSync(clone, { recursive: true, force: true });
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const serveRun = (serveCommand as unknown as { run: RunFn }).run;

async function runServe(args: Record<string, unknown>): Promise<number> {
  try {
    await serveRun({ args, rawArgs: [] });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

// ---------- 1. Source-grep tests (T-5-05-01 defense-in-depth) ----------

describe("serve.ts source invariants (T-5-05-01 loopback bind)", () => {
  test('hostname "127.0.0.1" appears at every Bun.serve construction site (≥ 2)', async () => {
    const src = await Bun.file(SERVE_SRC).text();
    const matches = src.match(/hostname:\s*"127\.0\.0\.1"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test("the substring 0.0.0.0 NEVER appears in serve.ts (defense in depth)", async () => {
    const src = await Bun.file(SERVE_SRC).text();
    expect(src.includes("0.0.0.0")).toBe(false);
  });

  test("serve.ts does NOT declare a --host / --hostname / --bind citty arg", async () => {
    const src = await Bun.file(SERVE_SRC).text();
    // Strip comment lines + the hardcoded `hostname:` Bun.serve lines so the
    // search can't false-positive on the source comments or the literal
    // hostname assignment.
    const lines = src.split("\n").filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        return false;
      }
      // The `hostname: "127.0.0.1"` lines are the only legitimate sites.
      if (/hostname:\s*"127\.0\.0\.1"/.test(trimmed)) return false;
      return true;
    });
    const stripped = lines.join("\n");
    // A citty arg declaration shape: `host: {`, `hostname: {`, `bind: {`.
    expect(/(\b(host|hostname|bind)\s*:\s*\{)/.test(stripped)).toBe(false);
  });
});

// ---------- 2. composeServeApp real-serve smoke ----------

// @spec SERV-003
describe("composeServeApp (real serve mode composition)", () => {
  test("composeServeApp(storage) returns a Hono that answers /api/coverage on 127.0.0.1", async () => {
    const dbPath = resolve(clone, ".spec-engine", "index.sqlite");
    const storage = openStorage(dbPath);
    await runIndex({ platformDir: clone, storage });

    // Phase 16 (PWEB-01): pass platformDir so the /api/provenance?resolve=1
    // seam writes its tracker sidecar under the clone, not the runner's cwd.
    const app = composeServeApp(storage, clone);
    // Bind ephemeral port 0 on loopback; assert the URL is 127.0.0.1:N.
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      expect(server.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${server.port}/api/coverage`);
      expect(res.status).toBe(200);
      const rows = await res.json();
      expect(Array.isArray(rows)).toBe(true);
      // Smoke: the page that the SSR side renders for / also works.
      const indexRes = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(indexRes.status).toBe(200);
      const indexBody = await indexRes.text();
      expect(indexBody).toContain("BILLING-009");
    } finally {
      server.stop();
      storage.close();
    }
  });
});

// ---------- 3. Citty argv validation (T-5-05-02, T-5-05-03) ----------

describe("serveCommand argv validation", () => {
  test("--port abc → stderr + exit 2 (T-5-05-03 non-integer)", async () => {
    const code = await runServe({ probe: false, port: "abc", platformDir: clone });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("--port");
  });

  test("--port -1 → exit 2 (T-5-05-03 negative)", async () => {
    const code = await runServe({ probe: false, port: "-1", platformDir: clone });
    expect(code).toBe(2);
  });

  test("--port 65536 → exit 2 (T-5-05-03 above range)", async () => {
    const code = await runServe({ probe: false, port: "65536", platformDir: clone });
    expect(code).toBe(2);
  });

  test("--out outside platformDir → exit 2 (T-5-05-02 path containment)", async () => {
    const code = await runServe({
      probe: false,
      port: "0",
      platformDir: clone,
      out: "../escape.sqlite",
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("--out");
  });
});

// ---------- RED-11: pre-index / pre-spec guidance ----------

describe("spec serve — pre-index guidance (RED-11)", () => {
  test("non-platform dir: friendly message + exit 2 (not 'failed to start'), no .spec-engine artifact", async () => {
    const bare = mkdtempSync(join(tmpdir(), "spec-serve-red11-"));
    try {
      const code = await runServe({ platformDir: bare, port: "0" });
      expect(code).toBe(2);
      expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(true);
      // Directs the user toward their first completed spec.
      expect(errs.some((m) => m.includes("spec domain new"))).toBe(true);
      // The old path wrapped the error in a generic exit-1 message.
      expect(errs.some((m) => m.includes("failed to start"))).toBe(false);
      // Guard runs BEFORE mkdirSync/openStorage: nothing written.
      expect(existsSync(join(bare, ".spec-engine"))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ---------- RED-14 dead-end audit ----------

describe("spec serve — probe branch + bind-failure branch (RED-14)", () => {
  test("--probe binds loopback:0, self-fetches the placeholder, exits 0 (D-14)", async () => {
    // Until now the probe branch was only exercised by CI smoke 5 against
    // the compiled binary — never by `bun test`.
    const code = await runServe({ probe: true });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("serve --probe OK");
  });

  test("--probe FAILED when / answers non-200 → exit 1 (fetch stubbed)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    try {
      const code = await runServe({ probe: true });
      expect(code).toBe(1);
      expect(errs.join("\n")).toContain("status was 500, expected 200");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("--probe FAILED when / answers 200 without the placeholder string → exit 1 (D-14)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html>wrong body</html>", { status: 200 })) as unknown as typeof fetch;
    try {
      const code = await runServe({ probe: true });
      expect(code).toBe(1);
      expect(errs.join("\n")).toContain("did not contain the placeholder string");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("--probe FAILED when the self-fetch throws → exit 1 via the catch", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("connection refused (stubbed)");
    }) as unknown as typeof fetch;
    try {
      const code = await runServe({ probe: true });
      expect(code).toBe(1);
      expect(errs.join("\n")).toContain("serve --probe FAILED:");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Bun.serve bind failure (port already taken) → storage closed, exit 1 'failed to start'", async () => {
    // Occupy a concrete loopback port so the real-serve branch's Bun.serve
    // throws EADDRINUSE inside the WR-01 try — the catch must close storage
    // and exit 1 (NOT the exit-2 crash convention: bind failure is an
    // environment problem, not a command crash).
    const blocker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("blocker"),
    });
    try {
      const code = await runServe({
        platformDir: clone,
        port: String(blocker.port),
      });
      expect(code).toBe(1);
      expect(errs.join("\n")).toContain(`failed to start on 127.0.0.1:${blocker.port}`);
    } finally {
      blocker.stop(true);
    }
  });
});
