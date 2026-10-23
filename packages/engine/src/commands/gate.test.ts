import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cloneFixture } from "../testing/cloneFixture";
import { entryOf, plantEdit } from "../testing/plant";
import { TestPlatform } from "../testing/platform";
import { specTag } from "../testing/specTag";
import { gateCommand } from "./gate";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  // A clone, so mutations and .spec-engine/ writes land outside the
  // canonical fixtures/platform-fixture/ tree.
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
  // Best-effort cleanup; ignore failures (tmpdir-bound, OS will reap).
  try {
    require("node:fs").rmSync(clone, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const gateRun = (gateCommand as unknown as { run: RunFn }).run;

async function runGate(args: Record<string, unknown>): Promise<number> {
  try {
    await gateRun({ args, rawArgs: [] });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

/** JSON mode only: there the outcome is the sole stdout line. */
function lastLogAsJson<T = Record<string, unknown>>(): T {
  const last = logs.at(-1) ?? "";
  return JSON.parse(last) as T;
}

describe("spec gate (in-process)", () => {
  test("PASS: api BILLING-009 against canonical fixture", async () => {
    // api is pinned @2; BILLING-009 changed at @2 by superseding BILLING-001.
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(0);
    const out = lastLogAsJson<{
      pass: boolean;
      reason: string;
      pinned_spec_version: number;
      changed_at_version: number;
    }>();
    expect(out.pass).toBe(true);
    expect(out.reason).toBe("PASS");
    expect(out.pinned_spec_version).toBe(2);
    expect(out.changed_at_version).toBe(2);
  });

  test("SUPERSEDED: mobile BILLING-001 — detail names successor BILLING-009", async () => {
    const code = await runGate({
      repo: "mobile",
      reqId: "BILLING-001",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(1);
    const out = lastLogAsJson<{ reason: string; detail: string }>();
    expect(out.reason).toBe("SUPERSEDED");
    expect(out.detail).toContain("BILLING-009");
  });

  test("NOT_FOUND: api BILLING-999 — status === null", async () => {
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-999",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(1);
    const out = lastLogAsJson<{ reason: string; status: string | null }>();
    expect(out.reason).toBe("NOT_FOUND");
    expect(out.status).toBeNull();
  });

  test("NOT_FOUND: api COMPLETELY-MADE-UP-1000 — NOT_FOUND is req-only", async () => {
    const code = await runGate({
      repo: "api",
      reqId: "COMPLETELY-MADE-UP-1000",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(1);
    const out = lastLogAsJson<{ reason: string }>();
    expect(out.reason).toBe("NOT_FOUND");
  });

  test("DRAFT: cloneFixture mutation flips BILLING-009 Active → Draft", async () => {
    await plantEdit(clone, "BILLING", (spec) => {
      const b9 = entryOf(spec, "BILLING-009");
      expect(b9.status).toBe("active");
      b9.status = "draft";
    });

    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(1);
    const out = lastLogAsJson<{ reason: string }>();
    expect(out.reason).toBe("DRAFT");
  });

  test("VERSION_PIN: cloneFixture mutation supersedes BILLING-002 + mobile@1 tag", async () => {
    // Supersede BILLING-002 with a new Active successor. Under the DERIVED
    // domain version (1 + edge count), the fixture already carries one edge
    // (BILLING-001→009); this supersession adds the second, so the derived
    // version is 3 — the successor changes at @3.
    const { newId } = await TestPlatform.at(clone).handle("BILLING").supersede("BILLING-002", {
      statement: "Stand-in for the VERSION_PIN gate reason.",
      why: "Locks the VERSION_PIN reason without disturbing the canonical fixture.",
    });

    // Plant the member tag in mobile (pinned @1).
    const memberPath = join(clone, "mobile", "src", "test-version-pin.ts");
    writeFileSync(
      memberPath,
      `${specTag(newId)}export function testVersionPin() {\n  /* PoC */\n}\n`,
    );

    const code = await runGate({
      repo: "mobile",
      reqId: newId,
      platformDir: clone,
      json: true,
    });
    const out = lastLogAsJson<{
      reason: string;
      detail: string;
      changed_at_version: number;
      pinned_spec_version: number;
    }>();
    if (code !== 1 || out.reason !== "VERSION_PIN") {
      console.error(
        `VERSION_PIN diagnostic: code=${code} reason=${out.reason} ` +
          `changed_at_version=${out.changed_at_version} pin=${out.pinned_spec_version} ` +
          `detail=${out.detail}`,
      );
    }
    expect(code).toBe(1);
    expect(out.reason).toBe("VERSION_PIN");
    expect(out.detail).toContain("@1"); // the pin
    expect(out.detail).toContain("@3"); // derived changed_at (1 + 2 edges)
    expect(out.changed_at_version).toBe(3);
  });

  test("unknown repo → exit 2 with 'unknown repo' on stderr, never NOT_FOUND", async () => {
    const code = await runGate({
      repo: "ghost-repo",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(2);
    const stderr = errs.join("\n");
    expect(stderr).toContain("unknown repo");
    expect(stderr).toContain("ghost-repo");
    // No stdout JSON outcome: the failure surface is stderr.
    expect(logs.length).toBe(0);
  });

  test("--out outside platformDir → exit 2 with 'must be inside platformDir'", async () => {
    const evilOut = resolve(clone, "..", "evil.sqlite");
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      out: evilOut,
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/must be inside platformDir/);
  });

  test("empty repo → exit 2", async () => {
    const code = await runGate({
      repo: "",
      reqId: "BILLING-009",
      platformDir: clone,
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/<repo> and <reqId> are required/);
  });

  test("whitespace-only reqId → exit 2", async () => {
    const code = await runGate({
      repo: "api",
      reqId: "   ",
      platformDir: clone,
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/<repo> and <reqId> are required/);
  });

  test("text mode appends build_id tail line (parity with check.ts)", async () => {
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: false,
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/^build_id: [0-9a-f]{64}$/m);
  });

  test("JSON mode does NOT emit build_id (clean for jq)", async () => {
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).not.toContain("build_id:");
    expect(logs.length).toBe(1);
    const out = lastLogAsJson<{ pass: boolean }>();
    expect(out.pass).toBe(true);
  });

  test("non-platform dir → friendly message + exit 2", async () => {
    const bare = mkdtempSync(join(tmpdir(), "spec-gate-bare-"));
    try {
      const code = await runGate({ repo: "api", reqId: "BILLING-009", platformDir: bare });
      expect(code).toBe(2);
      expect(errs.join("\n")).toContain("is not a Spec Engine platform yet");
      // The guard runs BEFORE mkdir/cold-rm — no .spec-engine/ artifact minted.
      expect(existsSync(join(bare, ".spec-engine"))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("no spec-engine.platform.json → zero manifest chrome, gate still runs", async () => {
    // The manifest is retired: its absence is the normal state, and the
    // platform version is derived from the domain SPEC.json files.
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect([0, 1]).toContain(code);
    expect(errs.join("\n")).not.toContain("spec-engine.platform.json");
  });

  test("EPIPE-shaped stdout write failures are swallowed — gate still exits 0", async () => {
    // Simulate `spec gate ... | head -1`: the member closed stdout, so
    // BOTH text-mode writes (decision line + build_id tail) throw EPIPE.
    console.log = () => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    };
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: false,
    });
    expect(code).toBe(0);
  });

  test("ERR_STREAM_DESTROYED is treated as EPIPE-shaped", async () => {
    console.log = () => {
      throw Object.assign(new Error("stream destroyed"), { code: "ERR_STREAM_DESTROYED" });
    };
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(0);
  });

  test("a NON-EPIPE stdout failure still crashes with exit 2", async () => {
    // A primitive throw exercises isEpipe's non-object guard; the rethrow
    // must land in the outer catch → "crashed" + exit 2, NOT exit 0/1.
    console.log = () => {
      // The non-Error throw shape IS the case under test (isEpipe's
      // non-object guard).
      throw "stdout exploded";
    };
    const code = await runGate({
      repo: "api",
      reqId: "BILLING-009",
      platformDir: clone,
      json: true,
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("spec gate: crashed:");
  });
});
