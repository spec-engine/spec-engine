// packages/engine/src/commands/req.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec REQ-022
// @spec REQ-023
// @spec REQ-024
// @spec REQ-025
// @spec REQ-026
// @spec REQ-027
// @spec REQ-028
// @spec REQ-019
// @spec REQ-029
// @spec REQ-026
// @spec REQ-030
// @spec REQ-032
// @spec REQ-037
//
// `spec req <domain-prefix> [platformDir]` resolves a case-insensitive
// domain prefix against the filesystem domain listing. On a TTY it authors a new
// requirement interactively; piped it prints the next unused requirement id
// (the composable id query).
//
// Behaviors asserted:
//   - case-insensitive prefix resolution (`bil` → BILLING); an exact match
//     wins over a longer-prefix ambiguity; an ambiguous prefix or no match
//     exits 2 with the candidates on stderr.
//   - next id is max(seq)+1, padded to 3 digits, over the working tree AND
//     the file at HEAD.
//   - `spec new` / `spec id` are GONE from the CLI surface.
//   - TTY gate: interactive per-field prompts (readline stubbed via
//     mock.module with a FIFO answer queue).
//   - non-TTY fallback prints the next id, zero mutation (in-process AND
//     subprocess layers).
//   - an empty Requirement aborts at exit 0, the file byte-unchanged.
//   - an append round-trips, advances nextRequirementId, bumps the envelope
//     `updated` to the LOCAL date.
//   - an unresolvable @-ref warns to stderr, the entry still saves.
//
// In-process tests drive `reqCommand.run` directly with the ExitError
// sentinel pattern; the subprocess tests spawn the real entrypoint with
// the running bun binary. process.stdin.isTTY is saved/restored per test;
// mock.restore() in afterEach resets mock.module state.

import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextRequirementId } from "../authoring/domains";
import { localToday } from "../authoring/edit";
import { plantEdit } from "../testing/plant";
import { type DomainHandle, type RequirementInput, TestPlatform } from "../testing/platform";
import { reqCommand } from "./req";

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
  // Restore the global isTTY snapshot (value may be undefined —
  // defineProperty with configurable: true is the correct restore).
  Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  // Reset mock.module("node:readline") state so the FIFO stub never leaks
  // across tests or sibling files via the shared module cache.
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
 * Scaffold `key` under `root` carrying `count` Active placeholder requirements
 * (KEY-001..KEY-<count>), optionally authored on a fixed past date so a bumped
 * `updated` is observable.
 */
async function seed(
  root: string,
  key: string,
  count: number,
  options: { scope?: string; updated?: string; first?: RequirementInput } = {},
): Promise<DomainHandle> {
  if (options.updated !== undefined) setSystemTime(new Date(`${options.updated}T12:00:00`));
  try {
    const domain = await TestPlatform.at(root).domain(
      key,
      options.scope === undefined ? {} : { scope: options.scope },
    );
    for (let i = 0; i < count; i++) {
      await domain.req(i === 0 && options.first ? options.first : { statement: "placeholder" });
    }
    return domain;
  } finally {
    if (options.updated !== undefined) setSystemTime();
  }
}

function readSpec(root: string, key: string): string {
  return readFileSync(join(root, "spec-engine", key, "SPEC.json"), "utf8");
}

/** Override process.stdin.isTTY via property descriptor (the beforeEach
 *  snapshot + afterEach restore make this global mutation safe). */
function setIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

/** Stub node:readline with a FIFO ANSWER QUEUE: each of the sequential field
 *  prompts consumes one queued answer; an exhausted queue yields "". */
function mockReadlineQueue(answers: string[]): void {
  const queue = [...answers];
  mock.module("node:readline", () => ({
    createInterface: () => ({
      question: (_q: string, cb: (a: string) => void) => cb(queue.shift() ?? ""),
      close: () => {},
    }),
  }));
}

describe("spec req — prefix resolution", () => {
  beforeEach(async () => {
    // BILLING max seq 9 → next 010; BOOKING + AUTH for ambiguity/exactness.
    await seed(tmp, "BILLING", 9);
    await seed(tmp, "BOOKING", 1);
    await seed(tmp, "AUTH", 1);
  });

  test("unique lowercase prefix `bil` resolves to BILLING → BILLING-010", async () => {
    await runReq("bil", tmp);
    expect(logs).toEqual(["BILLING-010"]);
  });

  test("exact match wins over longer-prefix ambiguity (`auth` with AUTH + AUTHX)", async () => {
    await seed(tmp, "AUTHX", 1);
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

describe("spec req — next-id correctness", () => {
  test("fresh domain with only KEY-001 → KEY-002", async () => {
    await seed(tmp, "FRESH", 1);
    await runReq("FRESH", tmp);
    expect(logs).toEqual(["FRESH-002"]);
  });

  // @spec REQ-018 unit
  test("a deleted entry's id is never re-minted — the file at HEAD holds the max", async () => {
    // Commit FRESH-001..003, then delete 003 from the working tree. The next
    // id must be 004, not a recycled 003 (ids are permanent).
    await seed(tmp, "FRESH", 3);
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", tmp, ...args], { stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(0);
    };
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed");
    await plantEdit(tmp, "FRESH", (doc) => {
      doc.requirements = doc.requirements.filter((r) => r.id !== "FRESH-003");
    });
    expect(await nextRequirementId(tmp, "FRESH")).toBe("FRESH-004");
  });

  test("outside git, the working-tree max alone decides (never-fail-non-git)", async () => {
    await seed(tmp, "FRESH", 2);
    expect(await nextRequirementId(tmp, "FRESH")).toBe("FRESH-003");
  });
});

describe("spec req — platform guard", () => {
  test("non-platform dir → exit 2 with friendly message", async () => {
    await expectExit2(() => runReq("anything", tmp));
    expect(errs.some((m) => m.includes("is not a Spec Engine platform"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Interactive authoring
// ---------------------------------------------------------------------------

describe("spec req — interactive authoring", () => {
  test("TTY append: three answers → the entry saves, updated: bumped, id round-trips", async () => {
    await seed(tmp, "BILLING", 9, { updated: "2020-01-01" });
    expect(JSON.parse(readSpec(tmp, "BILLING")).updated).toBe("2020-01-01");
    // A resolvable @-ref target for the happy path (no warning expected).
    mkdirSync(join(tmp, "api", "src"), { recursive: true });
    writeFileSync(join(tmp, "api", "src", "renew.ts"), "// seam\n");
    setIsTTY(true);
    mockReadlineQueue([
      "Charge renewals at current price",
      "Revenue correctness",
      "@api/src/renew.ts",
    ]);

    await runReq("bil", tmp);

    const domain = JSON.parse(readSpec(tmp, "BILLING"));
    // The appended requirement is a JSON object with status "active".
    const added = domain.requirements.find((r: { id: string }) => r.id === "BILLING-010");
    expect(added).toBeDefined();
    expect(added.status).toBe("active");
    expect(added.statement).toBe("Charge renewals at current price");
    expect(added.why).toBe("Revenue correctness");
    // `lives` flows to livesIn[].
    expect(added.livesIn).toEqual(["@api/src/renew.ts"]);
    // …envelope updated: bumped to today's LOCAL date…
    expect(domain.updated).toBe(localToday());
    // …and nextRequirementId advances past the appended entry.
    expect(await nextRequirementId(tmp, "BILLING")).toBe("BILLING-011");

    // stdout carries EXACTLY the confirmation — prompts went to stderr.
    expect(logs).toEqual(["appended BILLING-010 to spec-engine/BILLING/SPEC.json"]);
    // The resolving @-ref must NOT have warned.
    expect(errs.some((l) => l.includes("warning"))).toBe(false);
  });

  test("empty Requirement aborts: exit 0, stderr notice, SPEC.json byte-unchanged", async () => {
    await seed(tmp, "BILLING", 9, { updated: "2020-01-01" });
    const before = readSpec(tmp, "BILLING");
    setIsTTY(true);
    mockReadlineQueue([""]);

    let caught: ExitError | null = null;
    try {
      await runReq("bil", tmp);
    } catch (e) {
      if (e instanceof ExitError) caught = e;
      else throw e;
    }
    // Abort is exit 0 (git editor-abort tradition).
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe(0);
    expect(errs.some((l) => l.includes("aborted"))).toBe(true);
    expect(readSpec(tmp, "BILLING")).toBe(before);
    expect(logs).toEqual([]);
  });

  test("unresolvable @-ref warns to stderr but the entry STILL saves", async () => {
    await seed(tmp, "BILLING", 1, { updated: "2020-01-01" });
    setIsTTY(true);
    mockReadlineQueue(["Track refunds end to end", "Money correctness", "@does/not/exist.ts", ""]);

    await runReq("bil", tmp);

    expect(errs.some((l) => l.includes("warning") && l.includes("@does/not/exist.ts"))).toBe(true);
    // The unresolvable @-ref was in the Binds prompt (not persisted in JSON),
    // but the entry STILL saved — the warning never blocks the write.
    const domain = JSON.parse(readSpec(tmp, "BILLING"));
    const added = domain.requirements.find((r: { id: string }) => r.id === "BILLING-002");
    expect(added).toBeDefined();
    expect(added.statement).toBe("Track refunds end to end");
  });

  test("non-TTY in-process: prints next id, no prompts, no mutation", async () => {
    await seed(tmp, "BILLING", 9);
    const before = readSpec(tmp, "BILLING");
    setIsTTY(false);

    await runReq("bil", tmp);

    expect(logs).toEqual(["BILLING-010"]);
    expect(errs).toEqual([]);
    expect(readSpec(tmp, "BILLING")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Old commands gone — subprocess layer against the real cli.ts: spawn the
// running bun binary.
// ---------------------------------------------------------------------------

const CLI = join(import.meta.dir, "..", "cli.ts");

function runCli(...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, CLI, ...args],
    // stdin "ignore" — NOT a TTY, so the composable-id-query branch must fire
    // (no prompts, no writes).
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

describe("spec req — non-TTY subprocess keeps the composable id query", () => {
  test("piped `spec req bil <dir>` prints the next id, exits 0, SPEC.json unchanged", async () => {
    const sub = TestPlatform.temp("spec-req-pipe-");
    try {
      await seed(sub.dir, "BILLING", 9);
      const before = readSpec(sub.dir, "BILLING");
      const { exitCode, stdout } = runCli("req", "bil", sub.dir);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("BILLING-010");
      expect(readSpec(sub.dir, "BILLING")).toBe(before);
    } finally {
      sub.remove();
    }
  });
});

describe("spec new / spec id removed", () => {
  test("--help lists domain + req and has no new/id subcommand row", () => {
    const { exitCode, stdout } = runCli("--help");
    expect(exitCode).toBe(0);
    // citty colorizes subcommand names (`\x1b[36mdomain\x1b[39m`); strip
    // ANSI escapes so the line-anchored row regexes see plain text. Rows
    // render as `  <name>    <description>`.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping requires the ESC control char
    const plain = stdout.replace(/\[[0-9;]*m/g, "");
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
// SPEC.json is the ONLY spec format. `spec req` against a domain that owns no
// SPEC.json is a clean typed error + exit 2, never an ENOENT crash.
// ----------------------------------------------------------------------------

describe("spec req — domain with no SPEC.json", () => {
  test("no SPEC.json → a typed not_found refusal, not an ENOENT crash", async () => {
    // A domain dir that lists but has no spec file: the mint operation refuses
    // with a typed failure the command turns into exit 2.
    mkdirSync(join(tmp, "spec-engine", "GHOST"), { recursive: true });
    const { mint } = await import("../operations/mint");
    const result = await mint({
      platformDir: tmp,
      key: "GHOST",
      statement: "x",
      why: "",
      livesIn: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
    expect(result.detail).toContain("no domain GHOST");
  });
});

describe("nextRequirementId — missing SPEC.json", () => {
  test("domain dir without SPEC.json → defensive <KEY>-001", async () => {
    // No spec-engine/GHOST/SPEC.json is ever written in this tmp platform.
    const id = await nextRequirementId(tmp, "GHOST");
    expect(id).toBe("GHOST-001");
  });
});

// ----------------------------------------------------------------------------
// `--json` machine mode for the agent write-path: the next-id query emits a
// parseable object and NEVER prompts, even on a TTY (an agent that asked for
// JSON never wants readline).
// ----------------------------------------------------------------------------

describe("spec req --json — machine mode", () => {
  beforeEach(async () => {
    await seed(tmp, "BILLING", 9);
  });

  test("non-TTY + --json prints {domain, next_id}, zero writes", async () => {
    setIsTTY(undefined);
    const before = readSpec(tmp, "BILLING");
    await reqRun({ args: { domainPrefix: "bil", platformDir: tmp, json: true }, rawArgs: [] });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({ domain: "BILLING", next_id: "BILLING-010" });
    expect(readSpec(tmp, "BILLING")).toBe(before);
  });

  test("TTY + --json stays machine mode: JSON out, zero prompts, zero writes", async () => {
    setIsTTY(true);
    mockReadlineQueue([]); // would feed the interactive flow if it (wrongly) ran
    const before = readSpec(tmp, "BILLING");
    await reqRun({ args: { domainPrefix: "BILLING", platformDir: tmp, json: true }, rawArgs: [] });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({ domain: "BILLING", next_id: "BILLING-010" });
    expect(errs).toEqual([]); // no "Authoring …" banner, no abort notice
    expect(readSpec(tmp, "BILLING")).toBe(before);
  });
});

// ----------------------------------------------------------------------------
// Non-interactive authoring via field flags. With `--text`, the entry appends
// WITHOUT prompting (even non-TTY); --why / --lives fill the remaining fields
// (default empty). This is the agent write-path: one invocation, zero readline.
// ----------------------------------------------------------------------------

describe("spec req — field-flag authoring", () => {
  beforeEach(async () => {
    await seed(tmp, "BILLING", 9);
  });

  function added(): Record<string, unknown> {
    const domain = JSON.parse(readSpec(tmp, "BILLING"));
    return domain.requirements.find((r: { id: string }) => r.id === "BILLING-010");
  }

  test("non-TTY + --text appends the full entry without prompting", async () => {
    setIsTTY(undefined);
    await reqRun({
      args: {
        domainPrefix: "bil",
        platformDir: tmp,
        text: "Charge renewals at the current plan price",
        why: "revenue path",
        lives: "lib-billing/renew.ts",
      },
      rawArgs: [],
    });
    const entry = added();
    expect(entry).toBeDefined();
    expect(entry.status).toBe("active");
    expect(entry.statement).toBe("Charge renewals at the current plan price");
    expect(entry.why).toBe("revenue path");
    // `lives` → livesIn[].
    expect(entry.livesIn).toEqual(["lib-billing/renew.ts"]);
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
    expect(added().statement).toBe("flag-authored");
  });

  test("TTY + --text skips the interactive flow entirely (flags win)", async () => {
    setIsTTY(true);
    mockReadlineQueue([]); // would abort if the prompt flow (wrongly) ran
    await reqRun({
      args: { domainPrefix: "BILLING", platformDir: tmp, text: "tty flag-authored" },
      rawArgs: [],
    });
    expect(errs.join("\n")).not.toContain("Authoring");
    expect(added().statement).toBe("tty flag-authored");
  });

  test("--why/--lives without --text is a usage error (exit 2, nothing written)", async () => {
    setIsTTY(undefined);
    const before = readSpec(tmp, "BILLING");
    await expectExit2(() =>
      reqRun({
        args: { domainPrefix: "BILLING", platformDir: tmp, why: "orphan flag" },
        rawArgs: [],
      }),
    );
    expect(errs.join("\n")).toContain("--text");
    expect(readSpec(tmp, "BILLING")).toBe(before);
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
    expect(added().statement).toBe("see @no/such/file.ts");
  });
});

// ----------------------------------------------------------------------------
// `spec req` echoes the resolved domain's charter (scope) to STDERR at
// authoring time. The piped bare-id (stdout) and --json payload (stdout) must
// stay BYTE-IDENTICAL — charter chrome never leaks onto the machine channel.
// A null/absent charter degrades gracefully to a single "no charter set" notice.
// @spec CHRT-012 unit
// ----------------------------------------------------------------------------

describe("spec req — charter at authoring", () => {
  /** Scaffold `key` carrying a charter `scope` plus one active KEY-001 (so next id is KEY-002). */
  function writeScopedDomain(key: string, scope: string): Promise<DomainHandle> {
    return seed(tmp, key, 1, { scope });
  }

  test("(a) TTY authoring prints the charter to stderr, never stdout", async () => {
    await writeScopedDomain("GUARD", "guard the loss gate");
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
    await writeScopedDomain("GUARD", "guard the loss gate");
    setIsTTY(false);

    await runReq("guard", tmp);

    // The bare next id — EXACTLY as before charter existed (the machine contract).
    expect(logs).toEqual(["GUARD-002"]);
    // No charter chrome at all on the id-query path (not even stderr).
    expect(errs.some((l) => l.includes("guard the loss gate"))).toBe(false);
  });

  test("(c) --json id-query: stdout is byte-identical, zero charter chrome", async () => {
    await writeScopedDomain("GUARD", "guard the loss gate");
    setIsTTY(true);
    mockReadlineQueue([]); // would feed the interactive flow if it (wrongly) ran

    await reqRun({ args: { domainPrefix: "guard", platformDir: tmp, json: true }, rawArgs: [] });

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({ domain: "GUARD", next_id: "GUARD-002" });
    // The --json id query is not authoring — no charter, no "Authoring" banner.
    expect(errs).toEqual([]);
  });

  test("(d) null-scope domain degrades: 'no charter set' on stderr, stdout id intact", async () => {
    await seed(tmp, "PLAIN", 1); // no scope
    setIsTTY(true);
    mockReadlineQueue(["Another requirement", "", "", ""]);

    await runReq("PLAIN", tmp);

    // A single graceful notice on stderr — never charter text on stdout.
    expect(errs.some((l) => l.includes("no charter set for PLAIN"))).toBe(true);
    expect(logs).toEqual(["appended PLAIN-002 to spec-engine/PLAIN/SPEC.json"]);
  });

  test("(e) --text authoring echoes the charter to stderr, stdout confirmation intact", async () => {
    await writeScopedDomain("GUARD", "guard the loss gate");
    setIsTTY(false);

    await reqRun({
      args: { domainPrefix: "guard", platformDir: tmp, text: "A flag-authored requirement" },
      rawArgs: [],
    });

    expect(errs.some((l) => l.includes("guard the loss gate"))).toBe(true);
    expect(logs).toEqual(["appended GUARD-002 to spec-engine/GUARD/SPEC.json"]);
  });
});
