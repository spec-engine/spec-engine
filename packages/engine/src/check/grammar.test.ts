// @spec CHCK-008 integration
// @spec REQ-054 integration
// @spec SCHM-010 integration

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { reqCommand } from "../commands/req";
import { cloneFixture } from "../testing/cloneFixture";
import { entryOf, plantEdit } from "../testing/plant";
import { statementGrammarDiagnostics } from "./grammar";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

let platformDir: string;
let errs: string[];
let logs: string[];
let originalErr: typeof console.error;
let originalLog: typeof console.log;
let originalExit: typeof process.exit;

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  platformDir = cloneFixture(FIXTURE);
  errs = [];
  logs = [];
  originalErr = console.error;
  originalLog = console.log;
  originalExit = process.exit;
  console.error = (...a: unknown[]) => {
    errs.push(a.join(" "));
  };
  console.log = (...a: unknown[]) => {
    logs.push(a.join(" "));
  };
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new ExitError(code ?? 0);
  };
});

afterEach(() => {
  console.error = originalErr;
  console.log = originalLog;
  process.exit = originalExit;
  rmSync(platformDir, { recursive: true, force: true });
});

/** Declare grammar on a fixture domain's envelope after the fact. */
function declareGrammar(key: string, severity?: "warning" | "error"): Promise<void> {
  return plantEdit(platformDir, key, (doc) => {
    doc.grammar = "ears";
    if (severity) doc.grammarSeverity = severity;
  });
}

function readAuth(): {
  grammar?: string;
  grammarSeverity?: string;
  requirements: { id: string }[];
} {
  return JSON.parse(readFileSync(join(platformDir, "spec-engine", "AUTH", "SPEC.json"), "utf8"));
}

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const reqRun = (reqCommand as unknown as { run: RunFn }).run;

describe("STATEMENT_GRAMMAR — the check pass", () => {
  test("an undeclared domain emits nothing; a declared one flags nonconforming Active statements as warnings", async () => {
    expect(await statementGrammarDiagnostics(platformDir)).toEqual([]);

    // The fixture's AUTH-001 statement has no "shall" — nonconforming.
    await declareGrammar("AUTH");
    const rows = await statementGrammarDiagnostics(platformDir);
    expect(rows.length).toBe(1);
    expect(rows[0]?.code).toBe("STATEMENT_GRAMMAR");
    expect(rows[0]?.severity).toBe("warning");
    expect(rows[0]?.req_id).toBe("AUTH-001");
    expect(rows[0]?.detail).toContain("shall");
    expect(rows[0]?.detail).toContain("spec resolve shall print [] and exit 0");
  });

  test("grammarSeverity error promotes the rows to error severity", async () => {
    await declareGrammar("AUTH", "error");
    const rows = await statementGrammarDiagnostics(platformDir);
    expect(rows.length).toBe(1);
    expect(rows[0]?.severity).toBe("error");
  });

  test("superseded entries are history — never judged", async () => {
    await declareGrammar("BILLING");
    const rows = await statementGrammarDiagnostics(platformDir);
    // BILLING-001 is Superseded in the fixture; only Active nonconforming
    // statements may appear, and none of the flagged rows is BILLING-001.
    expect(rows.every((r) => r.req_id !== "BILLING-001")).toBe(true);
  });

  test("a conforming statement emits nothing", async () => {
    await declareGrammar("AUTH");
    await plantEdit(platformDir, "AUTH", (doc) => {
      entryOf(doc, "AUTH-001").statement =
        "When a session is idle for 30 days, the system shall expire it.";
    });
    expect(await statementGrammarDiagnostics(platformDir)).toEqual([]);
  });

  test("the grammar declaration round-trips through validateAndWrite (strip-trap)", async () => {
    await declareGrammar("AUTH", "error");
    await plantEdit(platformDir, "AUTH", () => {});
    const reread = readAuth();
    expect(reread.grammar).toBe("ears");
    expect(reread.grammarSeverity).toBe("error");
  });
});

describe("statement grammar — the write-time gate (spec req --text)", () => {
  test("warning severity: a nonconforming statement warns to stderr and still writes", async () => {
    await declareGrammar("AUTH");
    await reqRun({
      args: {
        domainPrefix: "AUTH",
        platformDir,
        text: "Sessions are important and should be secure.",
        json: true,
      },
      rawArgs: [],
    });
    expect(errs.join("\n")).toContain("does not match the domain's EARS shape");
    expect(errs.join("\n")).toContain("written anyway");
    expect(readAuth().requirements.some((r) => r.id === "AUTH-002")).toBe(true);
  });

  test("error severity: a nonconforming statement is refused (exit 2), nothing written", async () => {
    await declareGrammar("AUTH", "error");
    const before = readFileSync(join(platformDir, "spec-engine", "AUTH", "SPEC.json"), "utf8");
    let exitCode: number | null = null;
    try {
      await reqRun({
        args: {
          domainPrefix: "AUTH",
          platformDir,
          text: "Sessions are important and should be secure.",
        },
        rawArgs: [],
      });
    } catch (e) {
      if (e instanceof ExitError) exitCode = e.code;
      else throw e;
    }
    expect(exitCode).toBe(2);
    expect(readFileSync(join(platformDir, "spec-engine", "AUTH", "SPEC.json"), "utf8")).toBe(
      before,
    );
  });

  test("a conforming statement under error severity writes cleanly with clauses in --json", async () => {
    await declareGrammar("AUTH", "error");
    await reqRun({
      args: {
        domainPrefix: "AUTH",
        platformDir,
        text: "When a session is idle for 30 days, the system shall expire it.",
        json: true,
      },
      rawArgs: [],
    });
    const out = JSON.parse(logs[logs.length - 1] ?? "{}");
    expect(out.id).toBe("AUTH-002");
    expect(out.clauses?.pattern).toBe("when");
    expect(out.clauses?.system).toBe("system");
    expect(out.clauses?.condition).toBe("a session is idle for 30 days");
  });
});

// @spec CHCK-040 integration
// @spec CHCK-042 integration
describe("STATEMENT_GRAMMAR — the one-promise lint", () => {
  async function flagged(statement: string): Promise<string[]> {
    await declareGrammar("AUTH", "error");
    await plantEdit(platformDir, "AUTH", (doc) => {
      entryOf(doc, "AUTH-001").statement = statement;
    });
    const rows = await statementGrammarDiagnostics(platformDir);
    expect(rows.every((r) => r.severity === "error")).toBe(true);
    return rows.map((r) => r.detail);
  }

  test("a semicolon clause after shall is reported", async () => {
    const details = await flagged(
      "The system shall expire idle sessions; stale tokens are revoked.",
    );
    expect(details).toHaveLength(1);
    expect(details[0]).toContain('"; "');
  });

  test("a rationale connective is reported", async () => {
    const details = await flagged("The system shall expire idle sessions because they leak.");
    expect(details).toHaveLength(1);
    expect(details[0]).toContain('"because"');
  });

  test('a trailing ", so <consequence>" and a same-subject ", and shall" are not reported', async () => {
    const details = await flagged(
      "When a session is idle for 30 days, the system shall expire it, and shall log the expiry, so the next request re-authenticates.",
    );
    expect(details).toEqual([]);
  });
});

// @spec REQ-054 integration
describe("statement grammar — the write-time gate applies the one-promise lint", () => {
  test("error severity refuses a statement the lint flags (exit 2), nothing written", async () => {
    await declareGrammar("AUTH", "error");
    const before = readFileSync(join(platformDir, "spec-engine", "AUTH", "SPEC.json"), "utf8");
    let exitCode: number | null = null;
    try {
      await reqRun({
        args: {
          domainPrefix: "AUTH",
          platformDir,
          text: "The system shall expire idle sessions in order to limit exposure.",
        },
        rawArgs: [],
      });
    } catch (e) {
      if (e instanceof ExitError) exitCode = e.code;
      else throw e;
    }
    expect(exitCode).toBe(2);
    expect(errs.join("\n")).toContain('"in order to"');
    expect(readFileSync(join(platformDir, "spec-engine", "AUTH", "SPEC.json"), "utf8")).toBe(
      before,
    );
  });
});
