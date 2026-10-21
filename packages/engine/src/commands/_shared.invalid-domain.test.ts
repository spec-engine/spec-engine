import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { defaultIndexPath } from "../constants";
import { TestPlatform } from "../testing/platform";
import { cliFreshTags, withReadStorage } from "./_shared";

const PLANTED = join(import.meta.dir, "..", "testing", "fixtures", "diagnostics");

let fx: TestPlatform;
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

beforeEach(async () => {
  fx = TestPlatform.temp("spec-invalid-domain-");
  await (await fx.domain("ORD")).reqs(1);
  await fx.member("api");
  cpSync(join(PLANTED, "not-json", "spec-engine"), join(fx.dir, "spec-engine"), {
    recursive: true,
  });
  logs = [];
  errs = [];
  originalLog = console.log;
  originalErr = console.error;
  originalExit = process.exit;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errs.push(args.join(" "));
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new ExitError(code ?? 0);
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  fx.remove();
});

async function exitCode(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
  return -1;
}

const read = (json: boolean) =>
  withReadStorage({ platformDir: fx.dir, dbPath: defaultIndexPath(fx.dir), json }, () => {
    console.log("read ran");
  });

describe("a read command over an invalid SPEC.json", () => {
  // @spec INDX-017 unit
  test("--json prints only the check --json rows on stdout, exit 1", async () => {
    expect(await exitCode(() => read(true))).toBe(1);
    expect(errs).toEqual([]);
    const rows = JSON.parse(logs.join("")) as Array<{ code: string; source_file: string }>;
    expect(rows.map((r) => [r.code, r.source_file])).toEqual([
      ["INVALID_DOMAIN_FILE", "spec-engine/BROKEN/SPEC.json"],
    ]);
  });

  // @spec INDX-017 unit
  test("text mode prints only the rows on stderr, exit 1", async () => {
    expect(await exitCode(() => read(false))).toBe(1);
    expect(logs).toEqual([]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toStartWith("INVALID_DOMAIN_FILE\t\tspec-engine/BROKEN/SPEC.json");
  });
});

describe("a lifecycle command's fresh-tags reindex over an invalid SPEC.json", () => {
  // @spec INDX-017 unit
  test("prints only the rows on stderr and exits 2", async () => {
    expect(await exitCode(() => cliFreshTags(fx.dir)("ORD-001"))).toBe(2);
    expect(logs).toEqual([]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toStartWith("INVALID_DOMAIN_FILE");
  });
});
