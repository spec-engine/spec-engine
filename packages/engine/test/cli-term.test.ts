// packages/engine/test/cli-term.test.ts
//
// Wave B (06-02) — `spec term`: the glossary-term authoring surface, a thin
// req.ts-style wrapper over the EXISTING lifecycle machinery (FORK 4). A term
// IS a requirement row (Fork 1 = reuse): the definition lives in `statement`,
// the headword in `term`, its synonyms in `aliases`. Authoring writes through
// the ONE validateAndWrite seam (VAL-01); `spec term list` reads the
// filesystem (D-08 — no bun:sqlite in the command).
//
// Behaviors asserted:
//   - author: `spec term <name> --def <def>` appends TERM-NNN (term=name,
//     statement=def, aliases from --aliases), status active, through
//     validateAndWrite; the append round-trips + advances nextRequirementId.
//   - list: `spec term list` prints each TERM entry's id + name (+ status),
//     sorted by id.
//   - next-id (non-TTY, no --def): mirror req.ts's D-02 contract — print the
//     next unused TERM id, zero prompts, zero writes; --json emits
//     { domain, next_id }.
//   - revise (A2 in-place-with-bump): `spec term revise TERM-NNN --def`
//     rewrites the definition in place (SAME id) and BUMPS the envelope
//     specVersion — the one op requirements do not have (makes TERM_DRIFT
//     fire in Wave E).
//
// Non-TTY term id contract (chosen to match req.ts:167-172): when no
// --def/--text is supplied the command is a pure id query — bare next id on
// stdout (or { domain, next_id } under --json), zero writes. `--def` is the
// authoring gate (like req.ts's --text), so a term is only written when its
// definition is supplied. Tag lines composed via fixtures/specTag.ts.
//
// @spec REQ-014 unit

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextRequirementId } from "../src/authoring/domains";
import { termCommand, termListCommand, termReviseCommand } from "../src/commands/term";

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

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const termRun = (termCommand as unknown as { run: RunFn }).run;
const termListRun = (termListCommand as unknown as { run: RunFn }).run;
const termReviseRun = (termReviseCommand as unknown as { run: RunFn }).run;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-cli-term-"));
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
  Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  rmSync(tmp, { recursive: true, force: true });
});

/** Write a reserved, empty TERM domain (mirror the real spec-engine/TERM). */
function writeTermDomain(root: string, updated = "2026-07-08"): void {
  const dir = join(root, "spec-engine", "TERM");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SPEC.json"),
    `${JSON.stringify({ key: "TERM", owner: null, specVersion: 1, updated, requirements: [] }, null, 2)}\n`,
  );
}

function readTermDomain(): {
  key: string;
  specVersion: number;
  updated: string;
  requirements: Array<{
    id: string;
    status: string;
    statement: string;
    term?: string;
    aliases?: string[];
    changedAtVersion?: number;
  }>;
} {
  return JSON.parse(readFileSync(join(tmp, "spec-engine", "TERM", "SPEC.json"), "utf8"));
}

function setIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

// ── Test A — author ─────────────────────────────────────────────────────────
describe("spec term — author (Wave B)", () => {
  test("`spec term <name> --def` appends TERM-001 with term/statement, status active", async () => {
    writeTermDomain(tmp);
    await termRun({
      args: { name: "Domain", def: "a named subject area of requirements", platformDir: tmp },
      rawArgs: [],
    });
    const domain = readTermDomain();
    const added = domain.requirements.find((r) => r.id === "TERM-001");
    expect(added).toBeDefined();
    expect(added?.status).toBe("active");
    expect(added?.term).toBe("Domain");
    expect(added?.statement).toBe("a named subject area of requirements");
    expect(added?.aliases).toEqual([]);
    // The append round-trips and advances the allocator.
    expect(await nextRequirementId(tmp, "TERM")).toBe("TERM-002");
    expect(logs.join("\n")).toContain("TERM-001");
  });

  test("--aliases splits on comma into aliases[]; --json prints { id, file }", async () => {
    writeTermDomain(tmp);
    await termRun({
      args: {
        name: "Spec",
        def: "the SPEC.json artifact recording a domain",
        aliases: "SPEC.json, envelope",
        platformDir: tmp,
        json: true,
      },
      rawArgs: [],
    });
    const added = readTermDomain().requirements.find((r) => r.id === "TERM-001");
    expect(added?.aliases).toEqual(["SPEC.json", "envelope"]);
    expect(added?.term).toBe("Spec");
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({
      id: "TERM-001",
      file: "spec-engine/TERM/SPEC.json",
    });
  });
});

// ── Test B — list ───────────────────────────────────────────────────────────
describe("spec term list — enumerate (Wave B)", () => {
  test("lists both terms' ids + names after authoring, sorted by id", async () => {
    writeTermDomain(tmp);
    await termRun({
      args: { name: "Domain", def: "a subject area", platformDir: tmp },
      rawArgs: [],
    });
    await termRun({
      args: { name: "Requirement", def: "a durable KEY-NNN unit", platformDir: tmp },
      rawArgs: [],
    });
    logs.length = 0;
    await termListRun({ args: { platformDir: tmp }, rawArgs: [] });
    const out = logs.join("\n");
    expect(out).toContain("TERM-001");
    expect(out).toContain("Domain");
    expect(out).toContain("TERM-002");
    expect(out).toContain("Requirement");
  });

  test("--json emits a sorted array of { id, term, status }", async () => {
    writeTermDomain(tmp);
    await termRun({
      args: { name: "Domain", def: "a subject area", platformDir: tmp },
      rawArgs: [],
    });
    logs.length = 0;
    await termListRun({ args: { platformDir: tmp, json: true }, rawArgs: [] });
    expect(logs).toHaveLength(1);
    const arr = JSON.parse(logs[0] ?? "");
    expect(arr).toEqual([{ id: "TERM-001", term: "Domain", status: "active" }]);
  });
});

// ── Test C — next-id (non-TTY id query, no --def) ────────────────────────────
describe("spec term — non-TTY id query (D-02 mirror)", () => {
  test("no --def, non-TTY → prints the next unused TERM id, zero writes", async () => {
    writeTermDomain(tmp);
    const specPath = join(tmp, "spec-engine", "TERM", "SPEC.json");
    const before = readFileSync(specPath, "utf8");
    setIsTTY(false);
    await termRun({ args: { name: "X", platformDir: tmp }, rawArgs: [] });
    expect(logs).toEqual(["TERM-001"]);
    expect(readFileSync(specPath, "utf8")).toBe(before);
  });

  test("--json id query prints { domain, next_id }, zero writes", async () => {
    writeTermDomain(tmp);
    const specPath = join(tmp, "spec-engine", "TERM", "SPEC.json");
    const before = readFileSync(specPath, "utf8");
    await termRun({ args: { name: "X", platformDir: tmp, json: true }, rawArgs: [] });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({ domain: "TERM", next_id: "TERM-001" });
    expect(readFileSync(specPath, "utf8")).toBe(before);
  });
});

// ── Test (revise) — the A2 in-place-with-bump op ─────────────────────────────
describe("spec term revise — in-place definition edit with version bump (A2)", () => {
  test("revises the statement in place (same id) and bumps envelope specVersion", async () => {
    writeTermDomain(tmp);
    await termRun({
      args: { name: "Domain", def: "first definition", platformDir: tmp },
      rawArgs: [],
    });
    expect(readTermDomain().specVersion).toBe(1);
    logs.length = 0;
    await termReviseRun({
      args: { id: "TERM-001", def: "a sharper, revised definition", platformDir: tmp },
      rawArgs: [],
    });
    const domain = readTermDomain();
    const req = domain.requirements.find((r) => r.id === "TERM-001");
    expect(req?.id).toBe("TERM-001"); // same id
    expect(req?.statement).toBe("a sharper, revised definition");
    expect(req?.term).toBe("Domain"); // headword untouched
    // The one op requirements do not have: the envelope version bumps.
    expect(domain.specVersion).toBe(2);
    expect(req?.changedAtVersion).toBe(2);
  });

  test("revise on a non-TERM id is a usage error (exit 2)", async () => {
    writeTermDomain(tmp);
    let caught: ExitError | null = null;
    try {
      await termReviseRun({ args: { id: "BILLING-001", def: "x", platformDir: tmp }, rawArgs: [] });
    } catch (e) {
      if (e instanceof ExitError) caught = e;
      else throw e;
    }
    expect(caught?.code).toBe(2);
  });
});
