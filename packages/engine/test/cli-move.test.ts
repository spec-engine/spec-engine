// packages/engine/test/cli-move.test.ts
//
// 4.7 — `spec move <KEY-NNN> <NEW-DOMAIN>`: the cross-domain counterpart of
// supersede. Mints the successor in the TARGET domain carrying the source's
// fields, flips the source to superseded (cross-domain supersededBy), bumps
// BOTH envelopes' specVersion, and emits the retag worklist. Guards run before
// any write.
//
// Tag lines composed via test/fixtures/specTag.ts (dogfood rule).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveCommand } from "../src/commands/move";
import { specTag } from "./fixtures/specTag";

let tmp: string;
let platform: string;
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

function envelope(key: string, requirements: unknown[]): string {
  // A requirement (non-TERM) domain carries NO authored specVersion (SCHM-008).
  return `${JSON.stringify({ key, owner: null, updated: "2026-06-01", requirements }, null, 2)}\n`;
}

function activeReq(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: "active",
    statement: `${id} statement`,
    why: `${id} why`,
    supersedes: null,
    supersededBy: null,
    relates: [],
    livesIn: [`${id.toLowerCase()}.ts`],
    issues: [],
    changedAtVersion: 1,
    ...extra,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-move-"));
  platform = join(tmp, "platform");
  mkdirSync(join(platform, "spec-engine", "BILLING"), { recursive: true });
  mkdirSync(join(platform, "spec-engine", "AUTH"), { recursive: true });
  writeFileSync(
    join(platform, "spec-engine", "BILLING", "SPEC.json"),
    envelope("BILLING", [activeReq("BILLING-001"), activeReq("BILLING-002")]),
  );
  writeFileSync(
    join(platform, "spec-engine", "AUTH", "SPEC.json"),
    envelope("AUTH", [activeReq("AUTH-001")]),
  );
  mkdirSync(join(platform, "api", "src"), { recursive: true });
  writeFileSync(join(platform, "api", "spec-engine.member.json"), '{ "specs": "spec-engine@1" }\n');
  writeFileSync(
    join(platform, "api", "src", "renew.ts"),
    `export const renew = 1; ${specTag("BILLING-001")}`,
  );

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
  rmSync(tmp, { recursive: true, force: true });
});

interface Req {
  id: string;
  status: string;
  statement: string;
  why: string | null;
  supersededBy: string | null;
  supersededAtVersion?: number;
  livesIn: string[];
}
interface Domain {
  specVersion?: number;
  requirements: Req[];
}
function readDomain(key: string): Domain {
  return JSON.parse(readFileSync(join(platform, "spec-engine", key, "SPEC.json"), "utf8"));
}

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

describe("spec move — happy path (4.7)", () => {
  // @spec REQ-016 — move reports each side's DAG-derived version. The source
  // gains a supersede edge (0 → 1 edge, derived 1 → 2); the target gains only an
  // Active successor (no edge), so its derived version is UNCHANGED at 1. Neither
  // envelope carries an authored specVersion (SCHM-008).
  test("flips source, mints successor in target, reports each side's derived version", async () => {
    await moveRun({
      args: { id: "BILLING-001", newDomain: "AUTH", platformDir: platform, json: true },
      rawArgs: [],
    });

    const billing = readDomain("BILLING");
    const auth = readDomain("AUTH");
    const src = billing.requirements.find((r) => r.id === "BILLING-001");
    // Source flipped to superseded, pointing cross-domain at the successor.
    expect(src?.status).toBe("superseded");
    expect(src?.supersededBy).toBe("AUTH-002");
    // Died-at stamp is the source's DAG-derived version (one edge → 2).
    expect(src?.supersededAtVersion).toBe(2);
    // Successor appended Active in AUTH, copying the source's fields.
    const succ = auth.requirements.find((r) => r.id === "AUTH-002");
    expect(succ?.status).toBe("active");
    expect(succ?.statement).toBe("BILLING-001 statement");
    expect(succ?.why).toBe("BILLING-001 why");
    expect(succ?.livesIn).toEqual(["billing-001.ts"]);
    // Neither requirement domain carries an authored specVersion.
    expect(billing.specVersion).toBeUndefined();
    expect(auth.specVersion).toBeUndefined();

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

  test("--text/--why rewrite the successor as it moves (4.8)", async () => {
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
    const succ = readDomain("AUTH").requirements.find((r) => r.id === "AUTH-002");
    expect(succ?.statement).toBe("the session token expires after 30 minutes of inactivity");
    expect(succ?.why).toBe("an idle session must not stay authenticated forever");
  });

  // @spec REQ-016 — on requirement domains --no-bump is a no-op (no authored
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
    expect(readDomain("BILLING").specVersion).toBeUndefined();
    expect(readDomain("AUTH").specVersion).toBeUndefined();
    const out = JSON.parse(logs.join("\n")) as {
      source_spec_version: number | null;
      target_spec_version: number | null;
    };
    expect(out.source_spec_version).toBe(2);
    expect(out.target_spec_version).toBe(1);
  });
});

describe("spec move — guards (exit 2, nothing written)", () => {
  test("moving to the SAME domain is rejected (use supersede)", async () => {
    await expectExit2(() =>
      moveRun({
        args: { id: "BILLING-001", newDomain: "BILLING", platformDir: platform },
        rawArgs: [],
      }),
    );
    expect(errs.join("\n")).toContain("use spec supersede");
    // Unchanged.
    expect(readDomain("BILLING").requirements.find((r) => r.id === "BILLING-001")?.status).toBe(
      "active",
    );
  });

  test("a non-existent target domain is rejected with a domain-new hint", async () => {
    await expectExit2(() =>
      moveRun({
        args: { id: "BILLING-001", newDomain: "GHOST", platformDir: platform },
        rawArgs: [],
      }),
    );
    expect(errs.join("\n")).toContain("spec domain new GHOST");
    expect(readDomain("BILLING").requirements.find((r) => r.id === "BILLING-001")?.status).toBe(
      "active",
    );
  });

  test("a non-Active source is rejected", async () => {
    // Pre-supersede BILLING-002 so it is history, then try to move it.
    const billing = readDomain("BILLING");
    const two = billing.requirements.find((r) => r.id === "BILLING-002");
    if (two) {
      (two as { status: string }).status = "superseded";
      (two as { supersededBy: string }).supersededBy = "BILLING-001";
    }
    writeFileSync(
      join(platform, "spec-engine", "BILLING", "SPEC.json"),
      `${JSON.stringify(billing, null, 2)}\n`,
    );
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
