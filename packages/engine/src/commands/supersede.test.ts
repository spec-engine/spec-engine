// packages/engine/src/commands/supersede.test.ts
//
// `spec supersede <KEY-NNN>`: the core lifecycle operation, mechanized. Flips
// the old entry to `superseded` (supersededBy NEW), mints the successor Active
// (fields from flags; why/lives default-copied from the old entry), bumps the
// envelope `updated`, reindexes fresh, and emits the retag worklist (the old
// id's tag sites — the same sites spec check will flag as SUPERSEDED_REFERENCED
// until retagged). The envelope is written once through validateAndWrite.
//
// Tag lines composed via src/testing/specTag.ts (dogfood rule).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type DomainHandle, TestPlatform } from "../testing/platform";
import { specTag } from "../testing/specTag";
import { supersedeCommand } from "./supersede";

let fx: TestPlatform;
let platform: string;
let billing: DomainHandle;
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

/** The Active entry under test, the history it replaced, and the successor it will get. */
const ACTIVE = "BILLING-002";
const HISTORY = "BILLING-001";
const SUCCESSOR = "BILLING-003";

beforeEach(async () => {
  fx = TestPlatform.temp("spec-supersede-");
  platform = fx.dir;
  billing = await fx.domain("BILLING", { owner: "drea" });
  const ancient = await billing.req({ statement: "ancient truth", why: "history" });
  const current = await billing.supersede(ancient.id, {
    statement: "charge at signup price",
    why: "revenue",
    livesIn: ["renew.ts"],
  });
  expect(current.newId).toBe(ACTIVE);
  await fx.member("api", {
    files: {
      "src/renew.ts": `export const renew = 1; ${specTag(ACTIVE)}`,
      "test/renew.test.ts": `export const t = 1; ${specTag(ACTIVE, "unit")}`,
    },
  });

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
  fx.remove();
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

describe("spec supersede — happy path", () => {
  // @spec REQ-036 — a requirement domain reports the DAG-derived version, never
  // an authored counter. The fixture already holds one superseded edge, so
  // before this run the derived version is 2; superseding the Active entry adds
  // the second edge and the reported/died-at version is 3.
  test("flips old entry, mints successor with copied fields, reports the derived version, emits worklist", async () => {
    await supersedeRun({
      args: {
        id: ACTIVE,
        platformDir: platform,
        text: "charge at the CURRENT plan price",
        json: true,
      },
      rawArgs: [],
    });
    const domain = await billing.read();
    // Old entry flipped to superseded, pointing at the successor.
    const old = domain.requirements.find((r) => r.id === ACTIVE);
    expect(old?.status).toBe("superseded");
    expect(old?.supersededBy).toBe(SUCCESSOR);
    // Stamped with the DAG-derived version it died at (two edges → 3).
    expect(old?.supersededAtVersion).toBe(3);
    // Successor appended Active with the new statement.
    const succ = domain.requirements.find((r) => r.id === SUCCESSOR);
    expect(succ?.status).toBe("active");
    expect(succ?.statement).toBe("charge at the CURRENT plan price");
    // why/lives copied from the old entry by default.
    expect(succ?.why).toBe("revenue");
    expect(succ?.livesIn).toEqual(["renew.ts"]);
    // A requirement domain carries NO authored specVersion.
    expect(domain.specVersion).toBeUndefined();
    // JSON output: ids, file, DERIVED spec_version, retag worklist (both sites).
    expect(logs).toHaveLength(1);
    const out = JSON.parse(logs[0] ?? "");
    expect(out.old_id).toBe(ACTIVE);
    expect(out.new_id).toBe(SUCCESSOR);
    expect(out.file).toBe("spec-engine/BILLING/SPEC.json");
    expect(out.spec_version).toBe(3);
    const retagFiles = (out.retag as Array<{ file: string }>).map((r) => r.file);
    expect(retagFiles).toEqual(["api/src/renew.ts", "api/test/renew.test.ts"]);
  });

  test("--why/--lives flags override the copied fields", async () => {
    await supersedeRun({
      args: {
        id: ACTIVE,
        platformDir: platform,
        text: "new truth",
        why: "fresh rationale",
        lives: "checkout.ts",
      },
      rawArgs: [],
    });
    const succ = (await billing.read()).requirements.find((r) => r.id === SUCCESSOR);
    expect(succ?.why).toBe("fresh rationale");
    expect(succ?.livesIn).toEqual(["checkout.ts"]);
  });

  test("--binds is accepted but not persisted (the envelope has no binds); lives still copied", async () => {
    await supersedeRun({
      args: {
        id: ACTIVE,
        platformDir: platform,
        text: "new truth",
        binds: "plans.current_price",
      },
      rawArgs: [],
    });
    const raw = JSON.parse(await billing.raw()) as {
      requirements: Array<Record<string, unknown>>;
    };
    const succ = raw.requirements.find((r) => r.id === SUCCESSOR);
    expect(succ).toBeDefined();
    expect("binds" in (succ ?? {})).toBe(false);
    expect(succ?.livesIn).toEqual(["renew.ts"]); // still copied
  });

  // @spec REQ-036 — on a requirement domain --no-bump is a no-op: there is no
  // authored counter to hold back, so the died-at stamp is still the DAG-derived
  // version (two edges → 3) and no specVersion is written.
  test("--no-bump is a no-op on a requirement domain — the version stays DAG-derived", async () => {
    await supersedeRun({
      args: { id: ACTIVE, platformDir: platform, text: "new truth", noBump: true },
      rawArgs: [],
    });
    const domain = await billing.read();
    expect(domain.specVersion).toBeUndefined();
    expect(domain.requirements.find((r) => r.id === ACTIVE)?.supersededAtVersion).toBe(3);
  });

  test("text mode prints the retag worklist table + a check reminder", async () => {
    await supersedeRun({
      args: { id: ACTIVE, platformDir: platform, text: "new truth" },
      rawArgs: [],
    });
    const out = logs.join("\n");
    expect(out).toContain(`${ACTIVE} → ${SUCCESSOR}`);
    expect(out).toContain("api/src/renew.ts");
    expect(out).toContain("api/test/renew.test.ts");
    expect(errs.join("\n")).toContain("SUPERSEDED_REFERENCED");
  });
});

// ── supersede is domain-generic and works on TERM ids, but the successor
// object must carry the predecessor's term/aliases (not drop them). ─────────
describe("spec supersede — TERM successor carries term/aliases", () => {
  async function writeTermDomain(): Promise<DomainHandle> {
    const terms = await fx.terms();
    await fx.term({
      term: "Domain",
      definition: "a named subject area of requirements",
      aliases: ["subject area", "namespace"],
    });
    return terms;
  }

  // @spec REQ-034 unit
  test("successor carries the predecessor's term/aliases; predecessor flips to superseded", async () => {
    const terms = await writeTermDomain();
    await supersedeRun({
      args: { id: "TERM-001", platformDir: platform, text: "a revised definition of the term" },
      rawArgs: [],
    });
    const domain = await terms.read();
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
    const terms = await writeTermDomain();
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
    const succ = (await terms.read()).requirements.find((r) => r.id === "TERM-002");
    expect(succ?.term).toBe("Namespace");
    expect(succ?.aliases).toEqual(["ns", "area"]);
  });
});

describe("spec supersede — guards", () => {
  test("malformed id → exit 2", async () => {
    await expectExit2(() =>
      supersedeRun({ args: { id: "not-an-id", platformDir: platform, text: "x" }, rawArgs: [] }),
    );
  });

  test("unknown id → exit 2, nothing written", async () => {
    const before = await billing.raw();
    await expectExit2(() =>
      supersedeRun({
        args: { id: "BILLING-999", platformDir: platform, text: "x" },
        rawArgs: [],
      }),
    );
    expect(await billing.raw()).toBe(before);
  });

  test("already-superseded entry → exit 2 naming the successor", async () => {
    await expectExit2(() =>
      supersedeRun({
        args: { id: HISTORY, platformDir: platform, text: "x" },
        rawArgs: [],
      }),
    );
    expect(errs.join("\n")).toContain(ACTIVE);
  });

  test("non-TTY without --text → exit 2 (the successor needs its truth)", async () => {
    await expectExit2(() =>
      supersedeRun({ args: { id: ACTIVE, platformDir: platform }, rawArgs: [] }),
    );
    expect(errs.join("\n")).toContain("--text");
  });

  test("unknown domain → exit 2", async () => {
    await expectExit2(() =>
      supersedeRun({ args: { id: "ZZZ-001", platformDir: platform, text: "x" }, rawArgs: [] }),
    );
  });
});
