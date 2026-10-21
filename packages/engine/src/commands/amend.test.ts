// packages/engine/src/commands/amend.test.ts
//
// `spec amend <KEY-NNN>`: same id, fields revised in place, envelope
// `updated` bumped, the derived domain version untouched. Only Active and
// Draft entries amend; superseded/retired entries are history. A released
// entry's promise is superseded instead; its livesIn and relates still amend.
//
// Field mapping: --text→statement, --why→why, --lives→livesIn[], --relates→relates[].

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { localToday } from "../authoring/edit";
import { deriveDomainVersion } from "../parser/domainJson";
import { commitAndTag, git } from "../testing/git";
import { type DomainHandle, TestPlatform } from "../testing/platform";
import { specTag } from "../testing/specTag";
import { amendCommand } from "./amend";

let fx: TestPlatform;
let tmp: string;
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
const amendRun = (amendCommand as unknown as { run: RunFn }).run;

/** The Active entry under test and the superseded one it replaced. */
const ACTIVE = "BILLING-002";
const HISTORY = "BILLING-001";

beforeEach(async () => {
  fx = TestPlatform.temp("spec-amend-");
  tmp = fx.dir;
  // Author the fixture on a past date so a bumped `updated` is observable.
  setSystemTime(new Date("2026-06-01T12:00:00"));
  try {
    billing = await fx.domain("BILLING");
    const old = await billing.req({ statement: "old", why: "w" });
    const successor = await billing.supersede(old.id, {
      statement: "rough draft of the rule",
      why: "revenue",
      livesIn: ["renew.ts"],
    });
    expect(successor.newId).toBe(ACTIVE);
  } finally {
    setSystemTime();
  }

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

describe("spec amend", () => {
  test("amends the given fields in place; same id, derived version untouched, updated bumped", async () => {
    const before = await billing.read();
    expect(before.updated).toBe("2026-06-01");
    const versionBefore = deriveDomainVersion(before.requirements);

    await amendRun({
      args: {
        id: ACTIVE,
        platformDir: tmp,
        text: "the precise rule",
        why: "revenue correctness",
        json: true,
      },
      rawArgs: [],
    });
    const domain = await billing.read();
    const req = domain.requirements.find((r) => r.id === ACTIVE);
    expect(req).toBeDefined();
    expect(req?.status).toBe("active"); // status + id unchanged
    expect(req?.statement).toBe("the precise rule");
    expect(req?.why).toBe("revenue correctness");
    expect(req?.livesIn).toEqual(["renew.ts"]); // untouched field
    expect(deriveDomainVersion(domain.requirements)).toBe(versionBefore); // amend never bumps
    expect(domain.specVersion).toBeUndefined(); // no authored counter on a requirement domain
    expect(domain.updated).toBe(localToday()); // updated bumped
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual({
      id: ACTIVE,
      file: "spec-engine/BILLING/SPEC.json",
      fields_changed: ["requirement", "why"],
    });
  });

  test("--lives maps to livesIn[]", async () => {
    await amendRun({
      args: { id: ACTIVE, platformDir: tmp, lives: "checkout.ts" },
      rawArgs: [],
    });
    const req = (await billing.read()).requirements.find((r) => r.id === ACTIVE);
    expect(req?.livesIn).toEqual(["checkout.ts"]);
    expect(req?.statement).toBe("rough draft of the rule"); // untouched
  });

  // @spec REQ-043 unit
  test("repeated and comma-separated --lives replace livesIn with the whole list", async () => {
    await amendRun({
      args: { id: ACTIVE, platformDir: tmp, lives: "c.ts" },
      rawArgs: ["--lives", "a.ts", "--lives", "b.ts,c.ts"],
    });
    const req = (await billing.read()).requirements.find((r) => r.id === ACTIVE);
    expect(req?.livesIn).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  // @spec REQ-043 unit
  test("an empty --lives clears livesIn", async () => {
    await amendRun({ args: { id: ACTIVE, platformDir: tmp, lives: "" }, rawArgs: ["--lives", ""] });
    const req = (await billing.read()).requirements.find((r) => r.id === ACTIVE);
    expect(req?.livesIn).toEqual([]);
  });

  test("no field flags non-TTY → exit 2 (nothing to amend)", async () => {
    const before = await billing.raw();
    await expectExit2(() => amendRun({ args: { id: ACTIVE, platformDir: tmp }, rawArgs: [] }));
    expect(await billing.raw()).toBe(before);
  });

  test("superseded entry → exit 2 (amend is for unshipped truth)", async () => {
    await expectExit2(() =>
      amendRun({ args: { id: HISTORY, platformDir: tmp, text: "x" }, rawArgs: [] }),
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
    const before = await billing.raw();
    await expectExit2(() =>
      amendRun({ args: { id: ACTIVE, platformDir: tmp, text: "  " }, rawArgs: [] }),
    );
    expect(await billing.raw()).toBe(before);
  });

  test("@-ref warning fires on amended lives; save proceeds", async () => {
    await amendRun({
      args: { id: ACTIVE, platformDir: tmp, lives: "@missing/file.ts" },
      rawArgs: [],
    });
    expect(errs.join("\n")).toContain("@missing/file.ts");
    const req = (await billing.read()).requirements.find((r) => r.id === ACTIVE);
    expect(req?.livesIn).toEqual(["@missing/file.ts"]);
  });

  // @spec REQ-050 unit
  // @spec REQ-051 unit
  test("--relates replaces relates with every comma-split value; an empty value clears it", async () => {
    await amendRun({
      args: { id: ACTIVE, platformDir: tmp, relates: "BILLING-001" },
      rawArgs: ["--relates", "BILLING-001", "--relates", " BILLING-003 ,BILLING-004"],
    });
    let req = (await billing.read()).requirements.find((r) => r.id === ACTIVE);
    expect(req?.relates).toEqual(["BILLING-001", "BILLING-003", "BILLING-004"]);

    await amendRun({ args: { id: ACTIVE, platformDir: tmp, relates: "" }, rawArgs: [] });
    req = (await billing.read()).requirements.find((r) => r.id === ACTIVE);
    expect(req?.relates).toEqual([]);
  });
});

const release = (tag: string) => commitAndTag(tmp, tag);

describe("spec amend — release gate", () => {
  // @spec REQ-044 unit
  // @spec REQ-045 unit
  test("a released Active entry refuses a statement change, naming the tag and both escape hatches", async () => {
    writeFileSync(join(tmp, "renew.ts"), `export const renew = 1; ${specTag(ACTIVE)}`);
    release("v0.1.0");
    const before = await billing.raw();
    await expectExit2(() =>
      amendRun({ args: { id: ACTIVE, platformDir: tmp, text: "x" }, rawArgs: [] }),
    );
    const message = errs.join("\n");
    expect(message).toContain("v0.1.0");
    expect(message).toContain(`spec supersede ${ACTIVE}`);
    expect(message).toContain("--lives");
    expect(message).toContain("--relates");
    expect(await billing.raw()).toBe(before);
  });

  // @spec REQ-044 unit
  test("a released Active entry refuses a why change", async () => {
    release("v0.1.0");
    await expectExit2(() =>
      amendRun({ args: { id: ACTIVE, platformDir: tmp, why: "y" }, rawArgs: [] }),
    );
  });

  // @spec REQ-046 unit
  test("a released Active entry amends --lives and --relates in place", async () => {
    release("v0.1.0");
    await amendRun({
      args: { id: ACTIVE, platformDir: tmp, lives: "moved.ts", relates: "BILLING-001" },
      rawArgs: [],
    });
    const req = (await billing.read()).requirements.find((r) => r.id === ACTIVE);
    expect(req?.livesIn).toEqual(["moved.ts"]);
    expect(req?.relates).toEqual(["BILLING-001"]);
    expect(req?.statement).toBe("rough draft of the rule");
  });

  // @spec REQ-044 unit
  test("an entry minted after the newest release tag amends freely", async () => {
    release("v0.1.0");
    const later = await billing.req({ statement: "minted after the release", why: "w" });
    await amendRun({ args: { id: later.id, platformDir: tmp, text: "reworded" }, rawArgs: [] });
    const req = (await billing.read()).requirements.find((r) => r.id === later.id);
    expect(req?.statement).toBe("reworded");
  });

  // @spec REQ-047 unit
  test("a git repository with no v* tag treats every entry as unreleased", async () => {
    git(tmp, "init", "-q");
    git(tmp, "add", "-A");
    git(tmp, "commit", "-q", "-m", "work");
    git(tmp, "tag", "nightly");
    await amendRun({ args: { id: ACTIVE, platformDir: tmp, text: "refined" }, rawArgs: [] });
    const req = (await billing.read()).requirements.find((r) => r.id === ACTIVE);
    expect(req?.statement).toBe("refined");
  });

  // @spec REQ-047 unit
  test("a platform outside git amends a tagged entry freely", async () => {
    writeFileSync(join(tmp, "renew.ts"), `export const renew = 1; ${specTag(ACTIVE)}`);
    await amendRun({ args: { id: ACTIVE, platformDir: tmp, text: "refined" }, rawArgs: [] });
    const req = (await billing.read()).requirements.find((r) => r.id === ACTIVE);
    expect(req?.statement).toBe("refined");
  });

  test("Draft entry amends even after a release", async () => {
    const draft = await billing.req({
      status: "draft",
      statement: "a draft still being shaped",
      why: "w",
    });
    release("v0.1.0");
    await amendRun({
      args: { id: draft.id, platformDir: tmp, text: "reshaped draft", json: true },
      rawArgs: [],
    });
    const req = (await billing.read()).requirements.find((r) => r.id === draft.id);
    expect(req?.statement).toBe("reshaped draft");
  });
});

// ── amend is domain-generic — the --term/--aliases flags let it revise a TERM
// entry's glossary fields in place (same id, no specVersion bump), mirroring
// --text/--why/--lives on a requirement. ─────────────────────────────────────
describe("spec amend — TERM fields in place", () => {
  // @spec REQ-034 unit
  test("--term/--aliases/--def revise the fields in place; same id, specVersion untouched", async () => {
    const terms = await fx.terms();
    const term = await fx.term({
      term: "Domain",
      definition: "an early definition",
      aliases: ["old-alias"],
    });
    await amendRun({
      args: {
        id: term.id,
        platformDir: tmp,
        term: "Domain2",
        aliases: "ns, area",
        text: "revised definition",
        json: true,
      },
      rawArgs: [],
    });
    const domain = await terms.read();
    const req = domain.requirements.find((r) => r.id === term.id);
    expect(req?.term).toBe("Domain2");
    expect(req?.aliases).toEqual(["ns", "area"]);
    expect(req?.statement).toBe("revised definition");
    expect(domain.specVersion).toBe(1); // amend never bumps
  });
});
