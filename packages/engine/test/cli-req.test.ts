// packages/engine/test/cli-req.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec REQ-001
// @spec REQ-002
// @spec REQ-003
// @spec REQ-004
// @spec REQ-005
// @spec REQ-006
// @spec REQ-007
// @spec AUTHC-018
// @spec REQ-008
// @spec REQ-009
// @spec REQ-010
// @spec REQ-013
// @spec REQ-017
//
// `spec req <domain-prefix> [platformDir]` resolves a case-insensitive
// domain prefix against the filesystem domain listing. On a TTY it authors a new
// requirement interactively (260605-tqz / D-01); piped it prints the next
// unused requirement id (D-02 — the composable id query).
//
// Behaviors asserted (AUTHC IDs):
//   - AUTHC-010 — case-insensitive prefix resolution (`bil` → BILLING).
//   - AUTHC-011 — exact match wins over a longer-prefix ambiguity.
//   - AUTHC-012 — ambiguous prefix → exit 2 + candidate list on stderr.
//   - AUTHC-013 — no match → exit 2 + available-domains list on stderr.
//   - AUTHC-014 — next id is parseSpecFile max(seq)+1, padded to 3 digits.
//   - AUTHC-018 — `spec new` / `spec id` are GONE from the CLI surface
//     (subprocess assertions against src/cli.ts: not in --help, no scaffold
//     side effect, no next-id output).
//   - AUTHC-019 — TTY gate: interactive per-field prompts (readline stubbed
//     via mock.module with a FIFO answer queue — Plan 10-01 Approach A
//     extended from single-answer to four sequential prompts).
//   - AUTHC-020 — non-TTY fallback prints the next id, zero mutation
//     (in-process AND subprocess layers).
//   - AUTHC-021 — empty Requirement aborts at exit 0, SPEC.md byte-unchanged.
//   - AUTHC-022 — append round-trips through parseSpecFile, advances
//     nextRequirementId, bumps frontmatter `updated:` to the LOCAL date.
//   - AUTHC-024 — unresolvable @-ref warns to stderr, entry still saves.
//
// In-process tests drive `reqCommand.run` directly with the ExitError
// sentinel pattern; the subprocess tests spawn the real entrypoint with
// the running bun binary (cli-noargs.test.ts subprocess pattern).
// process.stdin.isTTY is saved/restored per test (cli-prompt.test.ts
// Pitfall 3 pattern); mock.restore() in afterEach resets mock.module state.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextRequirementId } from "../src/authoring/domains";
import { reqCommand } from "../src/commands/req";

let tmp: string;
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;
let originalIsTTY: boolean | undefined;

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-cli-req-"));
  logs = [];
  errs = [];
  originalLog = console.log;
  originalErr = console.error;
  originalExit = process.exit;
  originalIsTTY = process.stdin.isTTY;
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
  // Pitfall 3: restore the global isTTY snapshot (value may be undefined —
  // defineProperty with configurable: true is the correct restore).
  Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  // WR-02: reset mock.module("node:readline") state so the FIFO stub never
  // leaks across tests or sibling files via the shared module cache.
  mock.restore();
  rmSync(tmp, { recursive: true, force: true });
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const reqRun = (reqCommand as unknown as { run: RunFn }).run;

async function runReq(domainPrefix: string, platformDir: string): Promise<void> {
  await reqRun({ args: { domainPrefix, platformDir }, rawArgs: [] });
}

async function expectExit2(fn: () => Promise<void>): Promise<void> {
  let caught: ExitError | null = null;
  try {
    await fn();
  } catch (e) {
    if (e instanceof ExitError) caught = e;
    else throw e;
  }
  expect(caught).not.toBeNull();
  expect(caught?.code).toBe(2);
}

/**
 * Write a schema-valid SPEC.json for `key` carrying one `active` requirement
 * per seq. This is the JSON write format (17-04); `spec req` reads it back,
 * appends through validateAndWrite, and re-serializes it.
 */
function writeDomain(root: string, key: string, seqs: number[], updated = "2026-06-05"): void {
  const dir = join(root, "spec-engine", key);
  mkdirSync(dir, { recursive: true });
  const requirements = seqs.map((n) => ({
    id: `${key}-${String(n).padStart(3, "0")}`,
    status: "active",
    statement: "placeholder",
    why: null,
    supersedes: null,
    supersededBy: null,
    relates: [],
    livesIn: [],
    issues: [],
    changedAtVersion: 1,
  }));
  writeFileSync(
    join(dir, "SPEC.json"),
    `${JSON.stringify({ key, owner: null, specVersion: 1, updated, requirements }, null, 2)}\n`,
  );
}

/** Override process.stdin.isTTY via property descriptor (Pitfall 3 — the
 *  beforeEach snapshot + afterEach restore make this global mutation safe). */
function setIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

/** Stub node:readline with a FIFO ANSWER QUEUE (Plan 10-01 mock.module
 *  Approach A, extended from single-answer): each of the four sequential
 *  field prompts consumes one queued answer; an exhausted queue yields "". */
function mockReadlineQueue(answers: string[]): void {
  const queue = [...answers];
  mock.module("node:readline", () => ({
    createInterface: () => ({
      question: (_q: string, cb: (a: string) => void) => cb(queue.shift() ?? ""),
      close: () => {},
    }),
  }));
}

/** Today's date in the LOCAL timezone (domain.ts:93-97 construction —
 *  NEVER toISOString, which rolls forward at UTC midnight; WR-05). */
function localToday(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}

describe("spec req — prefix resolution (AUTHC-010/011/012/013)", () => {
  beforeEach(() => {
    // BILLING max seq 9 → next 010; BOOKING + AUTH for ambiguity/exactness.
    writeDomain(tmp, "BILLING", [1, 9]);
    writeDomain(tmp, "BOOKING", [1]);
    writeDomain(tmp, "AUTH", [1]);
  });

  test("unique lowercase prefix `bil` resolves to BILLING → BILLING-010", async () => {
    await runReq("bil", tmp);
    expect(logs).toEqual(["BILLING-010"]);
  });

  test("exact match wins over longer-prefix ambiguity (`auth` with AUTH + AUTHX)", async () => {
    writeDomain(tmp, "AUTHX", [1]);
    await runReq("auth", tmp);
    expect(logs).toEqual(["AUTH-002"]);
  });

  test("ambiguous prefix `b` exits 2 listing both candidates", async () => {
    await expectExit2(() => runReq("b", tmp));
    const msg = errs.join("\n");
    expect(msg).toContain("ambiguous");
    expect(msg).toContain("BILLING");
    expect(msg).toContain("BOOKING");
  });

  test("no-match prefix `zzz` exits 2 listing available domains", async () => {
    await expectExit2(() => runReq("zzz", tmp));
    const msg = errs.join("\n");
    expect(msg).toContain('no domain matches "zzz"');
    expect(msg).toContain("AUTH");
    expect(msg).toContain("BILLING");
    expect(msg).toContain("BOOKING");
  });
});

describe("spec req — next-id correctness (AUTHC-014)", () => {
  test("fresh domain with only KEY-001 → KEY-002", async () => {
    writeDomain(tmp, "FRESH", [1]);
    await runReq("FRESH", tmp);
    expect(logs).toEqual(["FRESH-002"]);
  });
});

describe("spec req — platform guard (AUTHC-015)", () => {
  test("non-platform dir → exit 2 with friendly message", async () => {
    await expectExit2(() => runReq("anything", tmp));
    expect(errs.some((m) => m.includes("is not a spec-check platform"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Interactive authoring (260605-tqz — AUTHC-019/021/022/024, D-01/D-03)
// ---------------------------------------------------------------------------

describe("spec req — interactive authoring (AUTHC-019/021/022/024)", () => {
  test("TTY append: four answers → parseable em-dash block, updated: bumped, id round-trips", async () => {
    writeDomain(tmp, "BILLING", [1, 9], "2020-01-01");
    // A resolvable @-ref target for the happy path (no warning expected).
    mkdirSync(join(tmp, "api", "src"), { recursive: true });
    writeFileSync(join(tmp, "api", "src", "renew.ts"), "// seam\n");
    setIsTTY(true);
    mockReadlineQueue([
      "Charge renewals at current price",
      "Revenue correctness",
      "",
      "@api/src/renew.ts",
    ]);

    await runReq("bil", tmp);

    const specPath = join(tmp, "spec-engine", "BILLING", "SPEC.json");
    const domain = JSON.parse(readFileSync(specPath, "utf-8"));
    // The appended requirement is a JSON object with status "active" (AUTHC-022).
    const added = domain.requirements.find((r: { id: string }) => r.id === "BILLING-010");
    expect(added).toBeDefined();
    expect(added.status).toBe("active");
    expect(added.statement).toBe("Charge renewals at current price");
    expect(added.why).toBe("Revenue correctness");
    // `lives` (4th prompt) flows to livesIn[]; `binds` is not persisted in JSON.
    expect(added.livesIn).toEqual(["@api/src/renew.ts"]);
    // …envelope updated: bumped to today's LOCAL date (WR-05)…
    expect(domain.updated).toBe(localToday());
    // …and nextRequirementId advances past the appended entry.
    expect(await nextRequirementId(tmp, "BILLING")).toBe("BILLING-011");

    // stdout carries EXACTLY the confirmation — prompts went to stderr.
    expect(logs).toEqual(["appended BILLING-010 to spec-engine/BILLING/SPEC.json"]);
    // The resolving @-ref must NOT have warned.
    expect(errs.some((l) => l.includes("warning"))).toBe(false);
  });

  test("empty Requirement aborts: exit 0, stderr notice, SPEC.json byte-unchanged (AUTHC-021)", async () => {
    writeDomain(tmp, "BILLING", [1, 9], "2020-01-01");
    const specPath = join(tmp, "spec-engine", "BILLING", "SPEC.json");
    const before = readFileSync(specPath, "utf-8");
    setIsTTY(true);
    mockReadlineQueue([""]);

    let caught: ExitError | null = null;
    try {
      await runReq("bil", tmp);
    } catch (e) {
      if (e instanceof ExitError) caught = e;
      else throw e;
    }
    // LOCKED per D-01: abort is exit 0 (git editor-abort tradition).
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe(0);
    expect(errs.some((l) => l.includes("aborted"))).toBe(true);
    expect(readFileSync(specPath, "utf-8")).toBe(before);
    expect(logs).toEqual([]);
  });

  test("unresolvable @-ref warns to stderr but the entry STILL saves (AUTHC-024, D-03)", async () => {
    writeDomain(tmp, "BILLING", [1], "2020-01-01");
    setIsTTY(true);
    mockReadlineQueue(["Track refunds end to end", "Money correctness", "@does/not/exist.ts", ""]);

    await runReq("bil", tmp);

    expect(errs.some((l) => l.includes("warning") && l.includes("@does/not/exist.ts"))).toBe(true);
    // The unresolvable @-ref was in the Binds prompt (not persisted in JSON),
    // but the entry STILL saved — the warning never blocks the write (D-03).
    const domain = JSON.parse(
      readFileSync(join(tmp, "spec-engine", "BILLING", "SPEC.json"), "utf-8"),
    );
    const added = domain.requirements.find((r: { id: string }) => r.id === "BILLING-002");
    expect(added).toBeDefined();
    expect(added.statement).toBe("Track refunds end to end");
  });

  test("non-TTY in-process: prints next id, no prompts, no mutation (AUTHC-020, D-02)", async () => {
    writeDomain(tmp, "BILLING", [1, 9]);
    const specPath = join(tmp, "spec-engine", "BILLING", "SPEC.json");
    const before = readFileSync(specPath, "utf-8");
    setIsTTY(false);

    await runReq("bil", tmp);

    expect(logs).toEqual(["BILLING-010"]);
    expect(errs).toEqual([]);
    expect(readFileSync(specPath, "utf-8")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Old commands gone (AUTHC-018) — subprocess layer against the real cli.ts.
// Pattern from cli-noargs.test.ts: spawn the running bun binary.
// ---------------------------------------------------------------------------

const CLI = join(import.meta.dir, "../src/cli.ts");

function runCli(...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, CLI, ...args],
    // stdin "ignore" — NOT a TTY, so the D-02 composable-id-query branch
    // must fire (no prompts, no writes).
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("spec req — non-TTY subprocess keeps the composable id query (AUTHC-020, D-02)", () => {
  test("piped `spec req bil <dir>` prints the next id, exits 0, SPEC.json unchanged", () => {
    const sub = mkdtempSync(join(tmpdir(), "spec-req-pipe-"));
    try {
      writeDomain(sub, "BILLING", [1, 9]);
      const specPath = join(sub, "spec-engine", "BILLING", "SPEC.json");
      const before = readFileSync(specPath, "utf-8");
      const { exitCode, stdout } = runCli("req", "bil", sub);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("BILLING-010");
      expect(readFileSync(specPath, "utf-8")).toBe(before);
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });
});

describe("spec new / spec id removed (AUTHC-018)", () => {
  test("--help lists domain + req and has no new/id subcommand row", () => {
    const { exitCode, stdout } = runCli("--help");
    expect(exitCode).toBe(0);
    // citty colorizes subcommand names (`\x1b[36mdomain\x1b[39m`); strip
    // ANSI escapes so the line-anchored row regexes see plain text. Rows
    // render as `  <name>    <description>`.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping requires the ESC control char
    const plain = stdout.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/^\s+domain\s/m);
    expect(plain).toMatch(/^\s+req\s/m);
    expect(plain).not.toMatch(/^\s+(new|id)\s/m);
  });

  test("`spec new TESTKEY` has no scaffold side effect", () => {
    const sub = mkdtempSync(join(tmpdir(), "spec-req-oldnew-"));
    try {
      runCli("new", "TESTKEY", sub);
      // Whatever citty's unknown-command behavior prints, the scaffold must
      // NOT have happened — assert by side-effect absence, not error text.
      expect(existsSync(join(sub, "spec-engine", "TESTKEY", "SPEC.md"))).toBe(false);
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });

  test("`spec id TESTKEY` prints no next id", () => {
    const sub = mkdtempSync(join(tmpdir(), "spec-req-oldid-"));
    try {
      const { stdout } = runCli("id", "TESTKEY", sub);
      expect(stdout).not.toContain("TESTKEY-001");
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });
});

// ----------------------------------------------------------------------------
// RED-14 dead-end audit: nextRequirementId's defensive missing-file branch
// (SPEC.json vanishing between the caller's listing and the read) existed
// without a covering test.
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Post-cutover (Phase 18, D2): SPEC.json is the ONLY spec format — the
// Markdown read/seed path is deleted. `spec req` against a domain that owns
// no SPEC.json is a clean typed error + exit 2, never an ENOENT crash.
// ----------------------------------------------------------------------------

describe("spec req — domain with no SPEC.json (D2)", () => {
  test("no SPEC.json → clean exit 2, not an ENOENT crash", async () => {
    // A domain dir that lists but has no spec file at all: create the dir so
    // listing sees it, then drive appendEntry indirectly is not possible (the
    // command resolves via listDomainKeys). Instead assert appendEntry's typed
    // error path directly by pointing at a key with an empty dir.
    mkdirSync(join(tmp, "spec-engine", "GHOST"), { recursive: true });
    setIsTTY(undefined);
    let caught: ExitError | null = null;
    try {
      const { appendEntry } = await import("../src/commands/req");
      await appendEntry(tmp, "GHOST", "GHOST-001", {
        requirement: "x",
        why: "",
        binds: "",
        lives: "",
      });
    } catch (e) {
      if (e instanceof ExitError) caught = e;
      else throw e;
    }
    expect(caught?.code).toBe(2);
    expect(errs.some((l) => l.includes("no domain GHOST"))).toBe(true);
  });
});

describe("nextRequirementId — missing SPEC.json (RED-14)", () => {
  test("domain dir without SPEC.json → defensive <KEY>-001", async () => {
    // No spec-engine/GHOST/SPEC.json is ever written in this tmp platform.
    const id = await nextRequirementId(tmp, "GHOST");
    expect(id).toBe("GHOST-001");
  });
});

// ----------------------------------------------------------------------------
// Audit hygiene pass T4 — `--json` machine mode for the agent write-path:
// the next-id query emits a parseable object and NEVER prompts, even on a
// TTY (an agent that asked for JSON never wants readline).
// ----------------------------------------------------------------------------

describe("spec req --json — machine mode", () => {
  beforeEach(() => {
    writeDomain(tmp, "BILLING", [1, 9]);
  });

  test("non-TTY + --json prints {domain, next_id}, zero writes", async () => {
    setIsTTY(undefined);
    const specPath = join(tmp, "spec-engine", "BILLING", "SPEC.json");
    const before = readFileSync(specPath, "utf8");
    await reqRun({ args: { domainPrefix: "bil", platformDir: tmp, json: true }, rawArgs: [] });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({ domain: "BILLING", next_id: "BILLING-010" });
    expect(readFileSync(specPath, "utf8")).toBe(before);
  });

  test("TTY + --json stays machine mode: JSON out, zero prompts, zero writes", async () => {
    setIsTTY(true);
    mockReadlineQueue([]); // would feed the interactive flow if it (wrongly) ran
    const specPath = join(tmp, "spec-engine", "BILLING", "SPEC.json");
    const before = readFileSync(specPath, "utf8");
    await reqRun({ args: { domainPrefix: "BILLING", platformDir: tmp, json: true }, rawArgs: [] });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({ domain: "BILLING", next_id: "BILLING-010" });
    expect(errs).toEqual([]); // no "Authoring …" banner, no abort notice
    expect(readFileSync(specPath, "utf8")).toBe(before);
  });
});

// ----------------------------------------------------------------------------
// L1 (lifecycle pass) — non-interactive authoring via field flags. With
// `--text`, the entry appends WITHOUT prompting (even non-TTY); --why /
// --binds / --lives fill the remaining fields (default empty). This is the
// agent write-path: one invocation, zero readline.
// ----------------------------------------------------------------------------

describe("spec req — field-flag authoring (L1)", () => {
  beforeEach(() => {
    writeDomain(tmp, "BILLING", [1, 9]);
  });

  test("non-TTY + --text appends the full entry without prompting", async () => {
    setIsTTY(undefined);
    await reqRun({
      args: {
        domainPrefix: "bil",
        platformDir: tmp,
        text: "Charge renewals at the current plan price",
        why: "revenue path",
        binds: "plans.price",
        lives: "lib-billing/renew.ts",
      },
      rawArgs: [],
    });
    const domain = JSON.parse(
      readFileSync(join(tmp, "spec-engine", "BILLING", "SPEC.json"), "utf8"),
    );
    const added = domain.requirements.find((r: { id: string }) => r.id === "BILLING-010");
    expect(added).toBeDefined();
    expect(added.status).toBe("active");
    expect(added.statement).toBe("Charge renewals at the current plan price");
    expect(added.why).toBe("revenue path");
    // `lives` → livesIn[]; `binds` (plans.price) is not persisted in JSON.
    expect(added.livesIn).toEqual(["lib-billing/renew.ts"]);
    // The append round-trips and advances the allocator.
    expect(await nextRequirementId(tmp, "BILLING")).toBe("BILLING-011");
    expect(logs.join("\n")).toContain("BILLING-010");
  });

  test("--text + --json prints { id, file } and writes", async () => {
    setIsTTY(undefined);
    await reqRun({
      args: { domainPrefix: "BILLING", platformDir: tmp, text: "flag-authored", json: true },
      rawArgs: [],
    });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({
      id: "BILLING-010",
      file: "spec-engine/BILLING/SPEC.json",
    });
    const domain = JSON.parse(
      readFileSync(join(tmp, "spec-engine", "BILLING", "SPEC.json"), "utf8"),
    );
    const added = domain.requirements.find((r: { id: string }) => r.id === "BILLING-010");
    expect(added.statement).toBe("flag-authored");
  });

  test("TTY + --text skips the interactive flow entirely (flags win)", async () => {
    setIsTTY(true);
    mockReadlineQueue([]); // would abort if the prompt flow (wrongly) ran
    await reqRun({
      args: { domainPrefix: "BILLING", platformDir: tmp, text: "tty flag-authored" },
      rawArgs: [],
    });
    expect(errs.join("\n")).not.toContain("Authoring");
    const domain = JSON.parse(
      readFileSync(join(tmp, "spec-engine", "BILLING", "SPEC.json"), "utf8"),
    );
    const added = domain.requirements.find((r: { id: string }) => r.id === "BILLING-010");
    expect(added.statement).toBe("tty flag-authored");
  });

  test("--why/--binds/--lives without --text is a usage error (exit 2, nothing written)", async () => {
    setIsTTY(undefined);
    const before = readFileSync(join(tmp, "spec-engine", "BILLING", "SPEC.json"), "utf8");
    await expectExit2(() =>
      reqRun({
        args: { domainPrefix: "BILLING", platformDir: tmp, why: "orphan flag" },
        rawArgs: [],
      }),
    );
    expect(errs.join("\n")).toContain("--text");
    expect(readFileSync(join(tmp, "spec-engine", "BILLING", "SPEC.json"), "utf8")).toBe(before);
  });

  test("empty --text is a usage error (exit 2)", async () => {
    setIsTTY(undefined);
    await expectExit2(() =>
      reqRun({ args: { domainPrefix: "BILLING", platformDir: tmp, text: "  " }, rawArgs: [] }),
    );
  });

  test("@-ref validation still warns on flag-supplied text, entry still saves", async () => {
    setIsTTY(undefined);
    await reqRun({
      args: { domainPrefix: "BILLING", platformDir: tmp, text: "see @no/such/file.ts" },
      rawArgs: [],
    });
    expect(errs.join("\n")).toContain("@no/such/file.ts");
    const domain = JSON.parse(
      readFileSync(join(tmp, "spec-engine", "BILLING", "SPEC.json"), "utf8"),
    );
    const added = domain.requirements.find((r: { id: string }) => r.id === "BILLING-010");
    expect(added.statement).toBe("see @no/such/file.ts");
  });
});

// ----------------------------------------------------------------------------
// CHRT-005 — `spec req` echoes the resolved domain's charter (scope) to STDERR
// at authoring time. The piped bare-id (stdout) and --json payload (stdout) must
// stay BYTE-IDENTICAL — charter chrome never leaks onto the machine channel.
// A null/absent charter degrades gracefully to a single "no charter set" notice.
// @spec CHRT-005 unit
// ----------------------------------------------------------------------------

describe("spec req — charter at authoring (CHRT-005)", () => {
  /** Write a schema-valid SPEC.json for `key` carrying a charter `scope` plus one
   *  active KEY-001 (so next id is KEY-002). */
  function writeScopedDomain(key: string, scope: string): void {
    const dir = join(tmp, "spec-engine", key);
    mkdirSync(dir, { recursive: true });
    const env = {
      key,
      owner: null,
      specVersion: 1,
      updated: "2026-06-05",
      scope,
      requirements: [
        {
          id: `${key}-001`,
          status: "active",
          statement: "placeholder",
          why: null,
          supersedes: null,
          supersededBy: null,
          relates: [],
          livesIn: [],
          issues: [],
          changedAtVersion: 1,
        },
      ],
    };
    writeFileSync(join(dir, "SPEC.json"), `${JSON.stringify(env, null, 2)}\n`);
  }

  test("(a) TTY authoring prints the charter to stderr, never stdout", async () => {
    writeScopedDomain("GUARD", "guard the loss gate");
    setIsTTY(true);
    mockReadlineQueue(["A durable requirement", "", "", ""]);

    await runReq("guard", tmp);

    // Charter on the chrome channel…
    expect(errs.some((l) => l.includes("guard the loss gate"))).toBe(true);
    // …and NEVER on stdout (which carries only the append confirmation).
    expect(logs.some((l) => l.includes("guard the loss gate"))).toBe(false);
    expect(logs).toEqual(["appended GUARD-002 to spec-engine/GUARD/SPEC.json"]);
  });

  test("(b) piped id-query: stdout is byte-identical, charter absent from stdout", async () => {
    writeScopedDomain("GUARD", "guard the loss gate");
    setIsTTY(false);

    await runReq("guard", tmp);

    // The bare next id — EXACTLY as before charter existed (D-02 machine contract).
    expect(logs).toEqual(["GUARD-002"]);
    // No charter chrome at all on the id-query path (not even stderr).
    expect(errs.some((l) => l.includes("guard the loss gate"))).toBe(false);
  });

  test("(c) --json id-query: stdout is byte-identical, zero charter chrome", async () => {
    writeScopedDomain("GUARD", "guard the loss gate");
    setIsTTY(true);
    mockReadlineQueue([]); // would feed the interactive flow if it (wrongly) ran

    await reqRun({ args: { domainPrefix: "guard", platformDir: tmp, json: true }, rawArgs: [] });

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({ domain: "GUARD", next_id: "GUARD-002" });
    // The --json id query is not authoring — no charter, no "Authoring" banner.
    expect(errs).toEqual([]);
  });

  test("(d) null-scope domain degrades: 'no charter set' on stderr, stdout id intact", async () => {
    writeDomain(tmp, "PLAIN", [1]); // no scope key
    setIsTTY(true);
    mockReadlineQueue(["Another requirement", "", "", ""]);

    await runReq("PLAIN", tmp);

    // A single graceful notice on stderr — never charter text on stdout.
    expect(errs.some((l) => l.includes("no charter set for PLAIN"))).toBe(true);
    expect(logs).toEqual(["appended PLAIN-002 to spec-engine/PLAIN/SPEC.json"]);
  });

  test("(e) --text authoring echoes the charter to stderr, stdout confirmation intact", async () => {
    writeScopedDomain("GUARD", "guard the loss gate");
    setIsTTY(false);

    await reqRun({
      args: { domainPrefix: "guard", platformDir: tmp, text: "A flag-authored requirement" },
      rawArgs: [],
    });

    expect(errs.some((l) => l.includes("guard the loss gate"))).toBe(true);
    expect(logs).toEqual(["appended GUARD-002 to spec-engine/GUARD/SPEC.json"]);
  });
});
