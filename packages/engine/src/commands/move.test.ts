// packages/engine/src/commands/move.test.ts
//
// `spec move <KEY-NNN> <NEW-DOMAIN>`: the cross-domain counterpart of
// supersede. Mints the successor in the TARGET domain carrying the source's
// fields, flips the source to superseded (cross-domain supersededBy), reports
// each envelope's derived version, and emits the retag worklist. Guards run
// before any write.
//
// Tag lines composed via src/testing/specTag.ts (dogfood rule).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type DomainHandle, TestPlatform } from "../testing/platform";
import { specTag } from "../testing/specTag";
import { moveCommand } from "./move";

let fx: TestPlatform;
let platform: string;
let billing: DomainHandle;
let auth: DomainHandle;
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

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const moveRun = (moveCommand as unknown as { run: RunFn }).run;

/** Mint an Active entry whose fields name the id it will receive. */
async function seed(domain: DomainHandle): Promise<string> {
  const id = await domain.nextId();
  await domain.req({
    statement: `${id} statement`,
    why: `${id} why`,
    livesIn: [`${id.toLowerCase()}.ts`],
  });
  return id;
}

beforeEach(async () => {
  fx = TestPlatform.temp("spec-move-");
  platform = fx.dir;
  billing = await fx.domain("BILLING");
  await seed(billing);
  await seed(billing);
  auth = await fx.domain("AUTH");
  await seed(auth);
  await fx.member("api", {
    files: { "src/renew.ts": `export const renew = 1; ${specTag("BILLING-001")}` },
  });

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
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as typeof process.exit;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
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

describe("spec move — happy path", () => {
  // @spec REQ-036 — move reports each side's DAG-derived version. The source
  // gains a supersede edge (0 → 1 edge, derived 1 → 2); the target gains only an
  // Active successor (no edge), so its derived version is UNCHANGED at 1. Neither
  // envelope carries an authored specVersion.
  test("flips source, mints successor in target, reports each side's derived version", async () => {
    await moveRun({
      args: { id: "BILLING-001", newDomain: "AUTH", platformDir: platform, json: true },
      rawArgs: [],
    });

    const billingDoc = await billing.read();
    const authDoc = await auth.read();
    const src = billingDoc.requirements.find((r) => r.id === "BILLING-001");
    // Source flipped to superseded, pointing cross-domain at the successor.
    expect(src?.status).toBe("superseded");
    expect(src?.supersededBy).toBe("AUTH-002");
    // Died-at stamp is the source's DAG-derived version (one edge → 2).
    expect(src?.supersededAtVersion).toBe(2);
    // Successor appended Active in AUTH, copying the source's fields.
    const succ = authDoc.requirements.find((r) => r.id === "AUTH-002");
    expect(succ?.status).toBe("active");
    expect(succ?.statement).toBe("BILLING-001 statement");
    expect(succ?.why).toBe("BILLING-001 why");
    expect(succ?.livesIn).toEqual(["billing-001.ts"]);
    // Neither requirement domain carries an authored specVersion.
    expect(billingDoc.specVersion).toBeUndefined();
    expect(authDoc.specVersion).toBeUndefined();

    // JSON output: derived source/target versions + retag worklist.
    const out = JSON.parse(logs.join("\n")) as {
      old_id: string;
      new_id: string;
      from_file: string;
      to_file: string;
      source_spec_version: number | null;
      target_spec_version: number | null;
      retag: Array<{ file: string }>;
    };
    expect(out.old_id).toBe("BILLING-001");
    expect(out.new_id).toBe("AUTH-002");
    expect(out.source_spec_version).toBe(2);
    expect(out.target_spec_version).toBe(1);
    expect(out.retag.map((r) => r.file)).toEqual(["api/src/renew.ts"]);
  });

  test("--text/--why rewrite the successor as it moves", async () => {
    await moveRun({
      args: {
        id: "BILLING-001",
        newDomain: "AUTH",
        platformDir: platform,
        text: "the session token expires after 30 minutes of inactivity",
        why: "an idle session must not stay authenticated forever",
        json: true,
      },
      rawArgs: [],
    });
    const succ = (await auth.read()).requirements.find((r) => r.id === "AUTH-002");
    expect(succ?.statement).toBe("the session token expires after 30 minutes of inactivity");
    expect(succ?.why).toBe("an idle session must not stay authenticated forever");
  });

  // @spec REQ-036 — on requirement domains --no-bump is a no-op (no authored
  // counter to hold back); both sides still report their DAG-derived versions
  // and neither writes a specVersion.
  test("--no-bump is a no-op on requirement domains — versions stay DAG-derived", async () => {
    await moveRun({
      args: {
        id: "BILLING-001",
        newDomain: "AUTH",
        platformDir: platform,
        noBump: true,
        json: true,
      },
      rawArgs: [],
    });
    expect((await billing.read()).specVersion).toBeUndefined();
    expect((await auth.read()).specVersion).toBeUndefined();
    const out = JSON.parse(logs.join("\n")) as {
      source_spec_version: number | null;
      target_spec_version: number | null;
    };
    expect(out.source_spec_version).toBe(2);
    expect(out.target_spec_version).toBe(1);
  });
});

describe("spec move — guards (exit 2, nothing written)", () => {
  async function statusOf(id: string): Promise<string | undefined> {
    return (await billing.read()).requirements.find((r) => r.id === id)?.status;
  }

  test("moving to the SAME domain is rejected (use supersede)", async () => {
    await expectExit2(() =>
      moveRun({
        args: { id: "BILLING-001", newDomain: "BILLING", platformDir: platform },
        rawArgs: [],
      }),
    );
    expect(errs.join("\n")).toContain("use spec supersede");
    // Unchanged.
    expect(await statusOf("BILLING-001")).toBe("active");
  });

  test("a non-existent target domain is rejected with a domain-new hint", async () => {
    await expectExit2(() =>
      moveRun({
        args: { id: "BILLING-001", newDomain: "GHOST", platformDir: platform },
        rawArgs: [],
      }),
    );
    expect(errs.join("\n")).toContain("spec domain new GHOST");
    expect(await statusOf("BILLING-001")).toBe("active");
  });

  test("a non-Active source is rejected", async () => {
    // Pre-supersede BILLING-002 so it is history, then try to move it.
    await billing.supersede("BILLING-002");
    await expectExit2(() =>
      moveRun({
        args: { id: "BILLING-002", newDomain: "AUTH", platformDir: platform },
        rawArgs: [],
      }),
    );
    expect(errs.join("\n")).toContain("only Active requirements move");
  });

  test("a malformed id is rejected", async () => {
    await expectExit2(() =>
      moveRun({
        args: { id: "not-an-id-!!", newDomain: "AUTH", platformDir: platform },
        rawArgs: [],
      }),
    );
  });
});
