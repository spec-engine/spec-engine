import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Diagnostic } from "@spec-engine/shared";
import { cloneFixture } from "../testing/cloneFixture";
import { checkCommand } from "./check";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const checkRun = (checkCommand as unknown as { run: RunFn }).run;

let platformDir: string;
let logs: string[];
let errs: string[];
const original = { log: console.log, error: console.error, exit: process.exit };

beforeEach(() => {
  platformDir = cloneFixture(FIXTURE);
  logs = [];
  errs = [];
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => errs.push(a.join(" "));
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new ExitError(code ?? 0);
  };
});

afterEach(() => {
  console.log = original.log;
  console.error = original.error;
  process.exit = original.exit;
  rmSync(platformDir, { recursive: true, force: true });
});

async function runCheck(config: unknown): Promise<number> {
  writeFileSync(join(platformDir, "spec-engine", "check.json"), JSON.stringify(config));
  try {
    await checkRun({ args: { platformDir, json: true, noPrompt: true, ci: true }, rawArgs: [] });
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
  return 0;
}

describe("spec check with spec-engine/check.json", () => {
  // @spec CHCK-039 unit
  test("a check.json that fails its schema exits 2 naming the file and the path", async () => {
    const code = await runCheck({ severity: [{ code: "DRIFT", severity: "fatal" }] });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("spec-engine/check.json: severity.0.severity");
  });

  // @spec CHCK-036 unit
  // @spec CHCK-038 unit
  test("rules grade and drop rows in the rendered output", async () => {
    await runCheck({
      severity: [
        { code: "DRIFT", severity: "off" },
        { code: "ORPHAN_REQ", severity: "warning", match: ["AUTH-001"] },
      ],
    });
    const rows = JSON.parse(logs[logs.length - 1] ?? "[]") as Diagnostic[];
    expect(rows.some((d) => d.code === "DRIFT")).toBe(false);
    expect(rows.find((d) => d.code === "ORPHAN_REQ" && d.req_id === "AUTH-001")?.severity).toBe(
      "warning",
    );
  });
});
