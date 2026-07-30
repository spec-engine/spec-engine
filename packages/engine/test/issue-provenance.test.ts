// packages/engine/test/issue-provenance.test.ts
//
// PROV-003: the authoring commands can finally WRITE issue provenance — the
// engine used to warn (UNSOURCED_CHANGE) about missing supersedes-via links
// while offering no way to record them.
//
//   spec req --issue       → { role: "created" } on the new entry
//   spec supersede --issue → { role: "supersedes-via" } on the predecessor
//                            and { role: "created" } on the successor
//   spec amend --issue     → { role: "amends-via" } appended
//
// The id is opaque provenance: stored verbatim, never validated as a
// requirement id, never routing.
//
// Verifies:
// @spec PROV-003 unit

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { amendCommand } from "../src/commands/amend";
import { reqCommand } from "../src/commands/req";
import { supersedeCommand } from "../src/commands/supersede";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

let platformDir: string;
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;
let originalIsTTY: boolean | undefined;

beforeEach(() => {
  platformDir = cloneFixture(FIXTURE);
  originalLog = console.log;
  originalErr = console.error;
  originalExit = process.exit;
  originalIsTTY = process.stdin.isTTY;
  console.log = () => {};
  console.error = () => {};
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
  rmSync(platformDir, { recursive: true, force: true });
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const reqRun = (reqCommand as unknown as { run: RunFn }).run;
const supersedeRun = (supersedeCommand as unknown as { run: RunFn }).run;
const amendRun = (amendCommand as unknown as { run: RunFn }).run;

function readReq(key: string, id: string): Record<string, unknown> | undefined {
  const doc = JSON.parse(
    readFileSync(join(platformDir, "spec-engine", key, "SPEC.json"), "utf8"),
  ) as { requirements: Array<Record<string, unknown>> };
  return doc.requirements.find((r) => r.id === id);
}

describe("issue provenance on the authoring commands (PROV-003)", () => {
  test("spec req --issue records created-provenance on the new entry", async () => {
    await reqRun({
      args: {
        domainPrefix: "AUTH",
        platformDir,
        text: "When a session token is revoked, the system shall reject it within one minute.",
        issue: "ENG-1234",
      },
      rawArgs: [],
    });
    expect(readReq("AUTH", "AUTH-002")?.issues).toEqual([{ role: "created", id: "ENG-1234" }]);
  });

  test("spec supersede --issue records supersedes-via on the predecessor and created on the successor", async () => {
    await supersedeRun({
      args: {
        id: "AUTH-001",
        platformDir,
        text: "When a session is idle for 30 days, the system shall expire it.",
        issue: "ENG-77",
      },
      rawArgs: [],
    });
    const old = readReq("AUTH", "AUTH-001");
    expect(old?.status).toBe("superseded");
    expect(old?.issues).toEqual(expect.arrayContaining([{ role: "supersedes-via", id: "ENG-77" }]));
    expect(readReq("AUTH", "AUTH-002")?.issues).toEqual([{ role: "created", id: "ENG-77" }]);
  });

  test("spec amend --issue appends amends-via and counts as a change", async () => {
    await amendRun({
      args: { id: "AUTH-001", platformDir, issue: "ENG-500" },
      rawArgs: [],
    });
    expect(readReq("AUTH", "AUTH-001")?.issues).toEqual(
      expect.arrayContaining([{ role: "amends-via", id: "ENG-500" }]),
    );
  });

  test("the id is opaque: a KEY-NNN-shaped ticket id stores verbatim", async () => {
    await reqRun({
      args: {
        domainPrefix: "AUTH",
        platformDir,
        text: "When a login fails five times, the system shall lock the account.",
        issue: "BILLING-009",
      },
      rawArgs: [],
    });
    expect(readReq("AUTH", "AUTH-002")?.issues).toEqual([{ role: "created", id: "BILLING-009" }]);
  });
});
