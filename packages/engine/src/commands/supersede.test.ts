// Tag lines are composed via src/testing/specTag.ts so the self-scan never
// indexes them as this repo's tags.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { entryOf, plantEdit } from "../testing/plant";
import { type DomainHandle, STATEMENTS, TestPlatform } from "../testing/platform";
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

const ACTIVE = "BILLING-002";
const HISTORY = "BILLING-001";
const SUCCESSOR = "BILLING-003";

beforeEach(async () => {
  fx = TestPlatform.temp("spec-supersede-");
  platform = fx.dir;
  billing = await fx.domain("BILLING", { owner: "drea" });
  const ancient = await billing.req({ statement: STATEMENTS[6], why: "history" });
  const current = await billing.supersede(ancient.id, {
    statement: STATEMENTS[4],
    why: "revenue",
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
  // @spec REQ-074
  // @spec REQ-065 integration
  // The fixture already holds one superseded edge (derived version 2); this
  // supersede adds the second, so the died-at version is 3.
  test("flips old entry, mints successor with copied fields, reports the derived version, retags the sites", async () => {
    await supersedeRun({
      args: {
        id: ACTIVE,
        platformDir: platform,
        text: STATEMENTS[0],
        json: true,
      },
      rawArgs: [],
    });
    const domain = await billing.read();
    const old = domain.requirements.find((r) => r.id === ACTIVE);
    expect(old?.status).toBe("superseded");
    expect(old?.supersededBy).toBe(SUCCESSOR);
    expect(old?.supersededAtVersion).toBe(3);
    const succ = domain.requirements.find((r) => r.id === SUCCESSOR);
    expect(succ?.status).toBe("active");
    expect(succ?.statement).toBe(STATEMENTS[0]);
    expect(succ?.why).toBe("revenue");
    expect(domain.specVersion).toBeUndefined();
    expect(logs).toHaveLength(1);
    const out = JSON.parse(logs[0] ?? "");
    expect(out.old_id).toBe(ACTIVE);
    expect(out.new_id).toBe(SUCCESSOR);
    expect(out.file).toBe("spec-engine/BILLING/SPEC.json");
    expect(out.spec_version).toBe(3);
    const retagFiles = (out.retagged as Array<{ file: string }>).map((r) => r.file);
    expect(retagFiles).toEqual(["api/src/renew.ts", "api/test/renew.test.ts"]);
    expect(readFileSync(join(platform, "api/test/renew.test.ts"), "utf8")).toBe(
      `export const t = 1; ${specTag(SUCCESSOR, "unit")}`,
    );
  });

  test("--why overrides the copied why", async () => {
    await supersedeRun({
      args: {
        id: ACTIVE,
        platformDir: platform,
        text: STATEMENTS[5],
        why: "fresh rationale",
      },
      rawArgs: [],
    });
    const succ = (await billing.read()).requirements.find((r) => r.id === SUCCESSOR);
    expect(succ?.why).toBe("fresh rationale");
  });

  test("--binds is accepted but not persisted (the envelope has no binds)", async () => {
    await supersedeRun({
      args: {
        id: ACTIVE,
        platformDir: platform,
        text: STATEMENTS[5],
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
  });

  // @spec REQ-074
  test("--no-bump is a no-op on a requirement domain — the version stays DAG-derived", async () => {
    await supersedeRun({
      args: { id: ACTIVE, platformDir: platform, text: STATEMENTS[5], noBump: true },
      rawArgs: [],
    });
    const domain = await billing.read();
    expect(domain.specVersion).toBeUndefined();
    expect(domain.requirements.find((r) => r.id === ACTIVE)?.supersededAtVersion).toBe(3);
  });

  test("text mode prints the retagged sites", async () => {
    await supersedeRun({
      args: { id: ACTIVE, platformDir: platform, text: STATEMENTS[5] },
      rawArgs: [],
    });
    const out = logs.join("\n");
    expect(out).toContain(`${ACTIVE} → ${SUCCESSOR}`);
    expect(out).toContain("api/src/renew.ts");
    expect(out).toContain("api/test/renew.test.ts");
    expect(out).toContain(`retagged 2 site(s) from ${ACTIVE} to ${SUCCESSOR}`);
  });
});

describe("spec supersede — the successor keeps what nobody chose to drop", () => {
  beforeEach(async () => {
    await plantEdit(platform, "BILLING", (doc) => {
      const entry = entryOf(doc, ACTIVE);
      entry.relates = [HISTORY];
      entry.cites = [{ term: "TERM-001", pinned: 1 }];
      entry.section = "Charging";
      entry.issues = [{ role: "created", id: "ENG-1" }];
    });
  });

  // @spec REQ-063 unit
  // @spec REQ-053 unit
  test("relates, cites, and section copy; issues hold only the new created row", async () => {
    await supersedeRun({
      args: { id: ACTIVE, platformDir: platform, text: STATEMENTS[0], issue: "ENG-9" },
      rawArgs: [],
    });
    const succ = (await billing.read()).requirements.find((r) => r.id === SUCCESSOR);
    expect(succ?.relates).toEqual([HISTORY]);
    expect(succ?.cites).toEqual([{ term: "TERM-001", pinned: 1 }]);
    expect(succ?.section).toBe("Charging");
    expect(succ?.issues).toEqual([{ role: "created", id: "ENG-9" }]);
  });

  // @spec REQ-078 unit
  test("--relates replaces the copied relates; an empty value clears it", async () => {
    await supersedeRun({
      args: { id: ACTIVE, platformDir: platform, text: STATEMENTS[0], relates: "" },
      rawArgs: ["--relates", ""],
    });
    const succ = (await billing.read()).requirements.find((r) => r.id === SUCCESSOR);
    expect(succ?.relates).toEqual([]);
    expect(succ?.issues).toEqual([]);
  });
});

describe("spec supersede — an id held outside its prefix's domain", () => {
  // @spec REQ-076 unit
  // @spec REQ-049 unit
  test("supersede AUTHUI-01 held in AUTH mints the successor in AUTH", async () => {
    const auth = await fx.domain("AUTH");
    await auth.req({ statement: "The auth service shall expire idle sessions." });
    await plantEdit(platform, "AUTH", (doc) => {
      entryOf(doc, "AUTH-001").id = "AUTHUI-01";
    });
    await supersedeRun({
      args: { id: "AUTHUI-01", platformDir: platform, text: STATEMENTS[3], json: true },
      rawArgs: [],
    });
    const out = JSON.parse(logs[0] ?? "");
    expect(out.new_id).toMatch(/^AUTH-\d{3}$/);
    expect(out.file).toBe("spec-engine/AUTH/SPEC.json");
    const doc = await auth.read();
    expect(doc.requirements.find((r) => r.id === "AUTHUI-01")?.supersededBy).toBe(out.new_id);
  });
});

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

  // @spec REQ-085 unit
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
