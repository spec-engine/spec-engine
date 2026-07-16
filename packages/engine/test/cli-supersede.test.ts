// packages/engine/test/cli-supersede.test.ts
//
// L2 (lifecycle pass) — `spec supersede <KEY-NNN>`: the core lifecycle
// operation, mechanized. Flips the old entry to `superseded` (supersededBy
// NEW), mints the successor Active (fields from flags; why/lives default-
// copied from the old entry), bumps envelope specVersion + updated,
// reindexes fresh, and emits the retag worklist (the old id's tag sites —
// the same sites spec check will flag as SUPERSEDED_REFERENCED until
// retagged).
//
// VAL-01 (17-05): supersede now mutates the domain OBJECT (flip predecessor
// status/supersededBy, bump envelope specVersion, push the successor object)
// and writes ONCE through validateAndWrite — no Markdown text edit, no
// bespoke Bun.write — then reindexes (deleting DB+WAL+SHM first).
//
// Tag lines composed via test/fixtures/specTag.ts (dogfood rule).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supersedeCommand } from "../src/commands/supersede";
import { specTag } from "./fixtures/specTag";

let tmp: string;
let platform: string;
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
const supersedeRun = (supersedeCommand as unknown as { run: RunFn }).run;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-supersede-"));
  platform = join(tmp, "platform");
  mkdirSync(join(platform, "spec-engine", "BILLING"), { recursive: true });
  writeFileSync(
    join(platform, "spec-engine", "BILLING", "SPEC.json"),
    `${JSON.stringify(
      {
        key: "BILLING",
        owner: "drea",
        updated: "2026-06-01",
        requirements: [
          {
            id: "BILLING-001",
            status: "active",
            statement: "charge at signup price",
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
            statement: "ancient truth",
            why: "history",
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
  mkdirSync(join(platform, "api", "src"), { recursive: true });
  mkdirSync(join(platform, "api", "test"), { recursive: true });
  writeFileSync(join(platform, "api", "spec-engine.member.json"), '{ "specs": "spec-engine@1" }\n');
  writeFileSync(
    join(platform, "api", "src", "renew.ts"),
    `export const renew = 1; ${specTag("BILLING-001")}`,
  );
  writeFileSync(
    join(platform, "api", "test", "renew.test.ts"),
    `export const t = 1; ${specTag("BILLING-001", "unit")}`,
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
  supersededAtVersion?: number;
  livesIn: string[];
}
interface Domain {
  key: string;
  specVersion: number;
  updated: string;
  requirements: DomainReq[];
}

function readDomain(): Domain {
  return JSON.parse(readFileSync(join(platform, "spec-engine", "BILLING", "SPEC.json"), "utf8"));
}

function readSpecRaw(): string {
  return readFileSync(join(platform, "spec-engine", "BILLING", "SPEC.json"), "utf8");
}

describe("spec supersede — happy path (L2)", () => {
  // @spec REQ-016 — a requirement domain reports the DAG-derived version, never
  // an authored counter. The fixture already holds one superseded edge
  // (BILLING-002), so before this run the derived version is 2; superseding
  // BILLING-001 adds the second edge and the reported/died-at version is 3 —
  // whereas the retired authored counter (had it survived) would have said 2.
  test("flips old entry, mints successor with copied fields, reports the derived version, emits worklist", async () => {
    await supersedeRun({
      args: {
        id: "BILLING-001",
        platformDir: platform,
        text: "charge at the CURRENT plan price",
        json: true,
      },
      rawArgs: [],
    });
    const domain = readDomain();
    // Old entry flipped to superseded, pointing at the successor.
    const old = domain.requirements.find((r) => r.id === "BILLING-001");
    expect(old?.status).toBe("superseded");
    expect(old?.supersededBy).toBe("BILLING-003");
    // Stamped with the DAG-derived version it died at (two edges → 3).
    expect(old?.supersededAtVersion).toBe(3);
    // Successor appended Active with the new statement.
    const succ = domain.requirements.find((r) => r.id === "BILLING-003");
    expect(succ?.status).toBe("active");
    expect(succ?.statement).toBe("charge at the CURRENT plan price");
    // why/lives copied from the old entry by default.
    expect(succ?.why).toBe("revenue");
    expect(succ?.livesIn).toEqual(["renew.ts"]);
    // A requirement domain carries NO authored specVersion (SCHM-008).
    expect(domain.specVersion).toBeUndefined();
    // JSON output: ids, file, DERIVED spec_version, retag worklist (both sites).
    expect(logs).toHaveLength(1);
    const out = JSON.parse(logs[0] ?? "");
    expect(out.old_id).toBe("BILLING-001");
    expect(out.new_id).toBe("BILLING-003");
    expect(out.file).toBe("spec-engine/BILLING/SPEC.json");
    expect(out.spec_version).toBe(3);
    const retagFiles = (out.retag as Array<{ file: string }>).map((r) => r.file);
    expect(retagFiles).toEqual(["api/src/renew.ts", "api/test/renew.test.ts"]);
  });

  test("--why/--lives flags override the copied fields", async () => {
    await supersedeRun({
      args: {
        id: "BILLING-001",
        platformDir: platform,
        text: "new truth",
        why: "fresh rationale",
        lives: "checkout.ts",
      },
      rawArgs: [],
    });
    const succ = readDomain().requirements.find((r) => r.id === "BILLING-003");
    expect(succ?.why).toBe("fresh rationale");
    expect(succ?.livesIn).toEqual(["checkout.ts"]);
  });

  test("--binds is accepted but not persisted (STOR-01 has no binds); lives still copied", async () => {
    await supersedeRun({
      args: {
        id: "BILLING-001",
        platformDir: platform,
        text: "new truth",
        binds: "plans.current_price",
      },
      rawArgs: [],
    });
    const succ = readDomain().requirements.find((r) => r.id === "BILLING-003") as unknown as Record<
      string,
      unknown
    >;
    expect("binds" in succ).toBe(false);
    expect((succ as unknown as DomainReq).livesIn).toEqual(["renew.ts"]); // still copied
  });

  // @spec REQ-016 — on a requirement domain --no-bump is a no-op: there is no
  // authored counter to hold back, so the died-at stamp is still the DAG-derived
  // version (two edges → 3) and no specVersion is written.
  test("--no-bump is a no-op on a requirement domain — the version stays DAG-derived", async () => {
    await supersedeRun({
      args: { id: "BILLING-001", platformDir: platform, text: "new truth", noBump: true },
      rawArgs: [],
    });
    const domain = readDomain();
    expect(domain.specVersion).toBeUndefined();
    expect(domain.requirements.find((r) => r.id === "BILLING-001")?.supersededAtVersion).toBe(3);
  });

  test("text mode prints the retag worklist table + a check reminder", async () => {
    await supersedeRun({
      args: { id: "BILLING-001", platformDir: platform, text: "new truth" },
      rawArgs: [],
    });
    const out = logs.join("\n");
    expect(out).toContain("BILLING-001 → BILLING-003");
    expect(out).toContain("api/src/renew.ts");
    expect(out).toContain("api/test/renew.test.ts");
    expect(errs.join("\n")).toContain("SUPERSEDED_REFERENCED");
  });
});

// ── Wave B (06-02): supersede is domain-generic and works on TERM ids, but
// the successor object must carry the predecessor's term/aliases (not drop
// them). ──────────────────────────────────────────────────────────────────
describe("spec supersede — TERM successor carries term/aliases (Wave B)", () => {
  function writeTermDomain(): void {
    const dir = join(platform, "spec-engine", "TERM");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SPEC.json"),
      `${JSON.stringify(
        {
          key: "TERM",
          owner: null,
          specVersion: 1,
          updated: "2026-07-08",
          requirements: [
            {
              id: "TERM-001",
              status: "active",
              statement: "a named subject area of requirements",
              term: "Domain",
              aliases: ["subject area", "namespace"],
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
    requirements: Array<{
      id: string;
      status: string;
      statement: string;
      term?: string;
      aliases?: string[];
      supersededBy?: string | null;
    }>;
  } {
    return JSON.parse(readFileSync(join(platform, "spec-engine", "TERM", "SPEC.json"), "utf8"));
  }

  test("successor carries the predecessor's term/aliases; predecessor flips to superseded", async () => {
    writeTermDomain();
    await supersedeRun({
      args: { id: "TERM-001", platformDir: platform, text: "a revised definition of the term" },
      rawArgs: [],
    });
    const domain = readTerm();
    const old = domain.requirements.find((r) => r.id === "TERM-001");
    expect(old?.status).toBe("superseded");
    expect(old?.supersededBy).toBe("TERM-002");
    const succ = domain.requirements.find((r) => r.id === "TERM-002");
    expect(succ?.status).toBe("active");
    expect(succ?.statement).toBe("a revised definition of the term");
    // term/aliases copied from the predecessor by default (not dropped).
    expect(succ?.term).toBe("Domain");
    expect(succ?.aliases).toEqual(["subject area", "namespace"]);
  });

  test("--term/--aliases override the copied term fields", async () => {
    writeTermDomain();
    await supersedeRun({
      args: {
        id: "TERM-001",
        platformDir: platform,
        text: "new def",
        term: "Namespace",
        aliases: "ns, area",
      },
      rawArgs: [],
    });
    const succ = readTerm().requirements.find((r) => r.id === "TERM-002");
    expect(succ?.term).toBe("Namespace");
    expect(succ?.aliases).toEqual(["ns", "area"]);
  });
});

describe("spec supersede — guards (L2)", () => {
  test("malformed id → exit 2", async () => {
    await expectExit2(() =>
      supersedeRun({ args: { id: "not-an-id", platformDir: platform, text: "x" }, rawArgs: [] }),
    );
  });

  test("unknown id → exit 2, nothing written", async () => {
    const before = readSpecRaw();
    await expectExit2(() =>
      supersedeRun({
        args: { id: "BILLING-999", platformDir: platform, text: "x" },
        rawArgs: [],
      }),
    );
    expect(readSpecRaw()).toBe(before);
  });

  test("already-superseded entry → exit 2 naming the successor", async () => {
    await expectExit2(() =>
      supersedeRun({
        args: { id: "BILLING-002", platformDir: platform, text: "x" },
        rawArgs: [],
      }),
    );
    expect(errs.join("\n")).toContain("BILLING-001");
  });

  test("non-TTY without --text → exit 2 (the successor needs its truth)", async () => {
    await expectExit2(() =>
      supersedeRun({ args: { id: "BILLING-001", platformDir: platform }, rawArgs: [] }),
    );
    expect(errs.join("\n")).toContain("--text");
  });

  test("unknown domain → exit 2", async () => {
    await expectExit2(() =>
      supersedeRun({ args: { id: "ZZZ-001", platformDir: platform, text: "x" }, rawArgs: [] }),
    );
  });
});
