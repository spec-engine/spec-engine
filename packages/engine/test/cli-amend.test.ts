// packages/engine/test/cli-amend.test.ts
//
// L3 (lifecycle pass) — `spec amend <KEY-NNN>`: the pre-production
// counterpart to supersede. Same id, fields revised in place, envelope
// `updated` bumped, specVersion NOT bumped (amend refines truth that has
// not shipped; supersede replaces truth that has). Only Active and Draft
// entries amend; superseded/retired entries are history.
//
// VAL-01 (17-05): amend now mutates the requirement OBJECT in the domain's
// SPEC.json and writes ONCE through validateAndWrite — no Markdown text
// edit, no bespoke Bun.write. Field mapping: --text→statement, --why→why,
// --lives→livesIn[]. `--binds` has no JSON home (STOR-01) — it is fed to
// the @-ref warner but never persisted.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amendCommand } from "../src/commands/amend";
import { specTag } from "./fixtures/specTag";

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
const amendRun = (amendCommand as unknown as { run: RunFn }).run;

/** Today's date in the LOCAL timezone (WR-05 — never toISOString). */
function localToday(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-amend-"));
  mkdirSync(join(tmp, "spec-engine", "BILLING"), { recursive: true });
  writeFileSync(
    join(tmp, "spec-engine", "BILLING", "SPEC.json"),
    `${JSON.stringify(
      {
        key: "BILLING",
        owner: null,
        specVersion: 1,
        updated: "2026-06-01",
        requirements: [
          {
            id: "BILLING-001",
            status: "active",
            statement: "rough draft of the rule",
            why: "revenue",
            supersedes: null,
            supersededBy: null,
            relates: [],
            livesIn: ["renew.ts"],
            issues: [],
            changedAtVersion: 1,
          },
          {
            id: "BILLING-002",
            status: "superseded",
            statement: "old",
            why: "w",
            supersedes: null,
            supersededBy: "BILLING-001",
            relates: [],
            livesIn: [],
            issues: [],
            changedAtVersion: 1,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

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
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as typeof process.exit;
  Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  rmSync(tmp, { recursive: true, force: true });
});

async function expectExit2(fn: () => Promise<void>): Promise<void> {
  let caught: ExitError | null = null;
  try {
    await fn();
  } catch (e) {
    if (e instanceof ExitError) caught = e;
    else throw e;
  }
  expect(caught?.code).toBe(2);
}

interface DomainReq {
  id: string;
  status: string;
  statement: string;
  why: string | null;
  supersededBy: string | null;
  livesIn: string[];
}
interface Domain {
  key: string;
  specVersion: number;
  updated: string;
  requirements: DomainReq[];
}

function readDomain(): Domain {
  return JSON.parse(readFileSync(join(tmp, "spec-engine", "BILLING", "SPEC.json"), "utf8"));
}

function readSpecRaw(): string {
  return readFileSync(join(tmp, "spec-engine", "BILLING", "SPEC.json"), "utf8");
}

describe("spec amend (L3)", () => {
  test("amends the given fields in place; same id, specVersion untouched, updated bumped", async () => {
    await amendRun({
      args: {
        id: "BILLING-001",
        platformDir: tmp,
        text: "the precise rule",
        why: "revenue correctness",
        json: true,
      },
      rawArgs: [],
    });
    const domain = readDomain();
    const req = domain.requirements.find((r) => r.id === "BILLING-001");
    expect(req).toBeDefined();
    expect(req?.status).toBe("active"); // status + id unchanged
    expect(req?.statement).toBe("the precise rule");
    expect(req?.why).toBe("revenue correctness");
    expect(req?.livesIn).toEqual(["renew.ts"]); // untouched field
    expect(domain.specVersion).toBe(1); // amend never bumps
    expect(domain.updated).toBe(localToday()); // updated bumped
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({
      id: "BILLING-001",
      file: "spec-engine/BILLING/SPEC.json",
      fields_changed: ["requirement", "why"],
    });
  });

  test("--lives maps to livesIn[]", async () => {
    await amendRun({
      args: { id: "BILLING-001", platformDir: tmp, lives: "checkout.ts" },
      rawArgs: [],
    });
    const req = readDomain().requirements.find((r) => r.id === "BILLING-001");
    expect(req?.livesIn).toEqual(["checkout.ts"]);
    expect(req?.statement).toBe("rough draft of the rule"); // untouched
  });

  test("no field flags non-TTY → exit 2 (nothing to amend)", async () => {
    const before = readSpecRaw();
    await expectExit2(() =>
      amendRun({ args: { id: "BILLING-001", platformDir: tmp }, rawArgs: [] }),
    );
    expect(readSpecRaw()).toBe(before);
  });

  test("superseded entry → exit 2 (amend is for unshipped truth)", async () => {
    await expectExit2(() =>
      amendRun({ args: { id: "BILLING-002", platformDir: tmp, text: "x" }, rawArgs: [] }),
    );
    expect(errs.join("\n")).toContain("Superseded");
  });

  test("unknown id → exit 2", async () => {
    await expectExit2(() =>
      amendRun({ args: { id: "BILLING-999", platformDir: tmp, text: "x" }, rawArgs: [] }),
    );
  });

  test("malformed id → exit 2", async () => {
    await expectExit2(() =>
      amendRun({ args: { id: "nope", platformDir: tmp, text: "x" }, rawArgs: [] }),
    );
  });

  test("empty --text → exit 2 (non-empty Requirement required)", async () => {
    const before = readSpecRaw();
    await expectExit2(() =>
      amendRun({ args: { id: "BILLING-001", platformDir: tmp, text: "  " }, rawArgs: [] }),
    );
    expect(readSpecRaw()).toBe(before);
  });

  test("@-ref warning fires on amended lives; save proceeds", async () => {
    await amendRun({
      args: { id: "BILLING-001", platformDir: tmp, lives: "@missing/file.ts" },
      rawArgs: [],
    });
    expect(errs.join("\n")).toContain("@missing/file.ts");
    const req = readDomain().requirements.find((r) => r.id === "BILLING-001");
    expect(req?.livesIn).toEqual(["@missing/file.ts"]);
  });
});

// ── REQ-015: amend is gated to UNSHIPPED entries. An Active requirement that
// code binds (an implementing or verifying @spec tag) is shipped truth — amend
// refuses and directs the author to supersede. A Draft entry, or an Active
// entry with zero bound tags, still amends. Bound = code-derived kind only. ──
describe("spec amend — REQ-015 bound-tag gate", () => {
  // @spec REQ-015 unit
  test("Active + implementing @spec tag → exit 2 (shipped; supersede instead), no write", async () => {
    writeFileSync(join(tmp, "renew.ts"), `export const renew = 1; ${specTag("BILLING-001")}`);
    const before = readSpecRaw();
    await expectExit2(() =>
      amendRun({ args: { id: "BILLING-001", platformDir: tmp, text: "x" }, rawArgs: [] }),
    );
    expect(errs.join("\n")).toContain("shipped");
    expect(readSpecRaw()).toBe(before); // gate runs before the write seam
  });

  test("Active + only a verifying test tag → exit 2 (a test binding is still shipping)", async () => {
    mkdirSync(join(tmp, "test"), { recursive: true });
    writeFileSync(
      join(tmp, "test", "renew.test.ts"),
      `export const t = 1; ${specTag("BILLING-001", "unit")}`,
    );
    await expectExit2(() =>
      amendRun({ args: { id: "BILLING-001", platformDir: tmp, text: "x" }, rawArgs: [] }),
    );
    expect(errs.join("\n")).toContain("shipped");
  });

  test("Active with zero bound tags still amends (the pre-ship path is unchanged)", async () => {
    // No code file planted → BILLING-001 has no bindings → amend proceeds.
    await amendRun({
      args: { id: "BILLING-001", platformDir: tmp, text: "refined pre-ship", json: true },
      rawArgs: [],
    });
    const req = readDomain().requirements.find((r) => r.id === "BILLING-001");
    expect(req?.statement).toBe("refined pre-ship");
  });

  test("Draft entry amends even when a code tag binds it (Draft is unshipped by definition)", async () => {
    // Rewrite the domain with a Draft BILLING-003 and bind it in code.
    const spec = JSON.parse(readSpecRaw()) as {
      requirements: Array<Record<string, unknown>>;
    };
    spec.requirements.push({
      id: "BILLING-003",
      status: "draft",
      statement: "a draft still being shaped",
      why: "w",
      supersedes: null,
      supersededBy: null,
      relates: [],
      livesIn: [],
      issues: [],
      changedAtVersion: 1,
    });
    writeFileSync(
      join(tmp, "spec-engine", "BILLING", "SPEC.json"),
      `${JSON.stringify(spec, null, 2)}\n`,
    );
    writeFileSync(join(tmp, "draft.ts"), `export const d = 1; ${specTag("BILLING-003")}`);
    await amendRun({
      args: { id: "BILLING-003", platformDir: tmp, text: "reshaped draft", json: true },
      rawArgs: [],
    });
    const req = readDomain().requirements.find((r) => r.id === "BILLING-003");
    expect(req?.statement).toBe("reshaped draft");
  });
});

// ── Wave B (06-02): amend is domain-generic — the --term/--aliases flags let
// it revise a TERM entry's glossary fields in place (same id, no specVersion
// bump), mirroring --text/--why/--lives on a requirement. ───────────────────
describe("spec amend — TERM fields in place (Wave B)", () => {
  function writeTermDomain(): void {
    const dir = join(tmp, "spec-engine", "TERM");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SPEC.json"),
      `${JSON.stringify(
        {
          key: "TERM",
          owner: null,
          specVersion: 1,
          updated: "2026-06-01",
          requirements: [
            {
              id: "TERM-001",
              status: "active",
              statement: "an early definition",
              term: "Domain",
              aliases: ["old-alias"],
              why: null,
              supersedes: null,
              supersededBy: null,
              relates: [],
              livesIn: [],
              issues: [],
              cites: [],
              changedAtVersion: 1,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
  }

  function readTerm(): {
    specVersion: number;
    requirements: Array<{ id: string; statement: string; term?: string; aliases?: string[] }>;
  } {
    return JSON.parse(readFileSync(join(tmp, "spec-engine", "TERM", "SPEC.json"), "utf8"));
  }

  test("--term/--aliases/--def revise the fields in place; same id, specVersion untouched", async () => {
    writeTermDomain();
    await amendRun({
      args: {
        id: "TERM-001",
        platformDir: tmp,
        term: "Domain2",
        aliases: "ns, area",
        text: "revised definition",
        json: true,
      },
      rawArgs: [],
    });
    const domain = readTerm();
    const req = domain.requirements.find((r) => r.id === "TERM-001");
    expect(req?.term).toBe("Domain2");
    expect(req?.aliases).toEqual(["ns", "area"]);
    expect(req?.statement).toBe("revised definition");
    expect(domain.specVersion).toBe(1); // amend never bumps
  });
});
