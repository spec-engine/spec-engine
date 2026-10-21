import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RelationRow } from "@spec-engine/shared";
import { cloneFixture } from "../testing/cloneFixture";
import { relationsCommand } from "./relations";

const RELATES_FIXTURE = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "relates-fixture",
);

let tmp: string;
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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-cli-relations-"));
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
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new ExitError(code ?? 0);
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  rmSync(tmp, { recursive: true, force: true });
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const relationsRun = (relationsCommand as unknown as { run: RunFn }).run;

/** -1 when relations returned without calling process.exit: an implicit exit 0. */
async function runRelations(args: Record<string, unknown>): Promise<number> {
  try {
    await relationsRun({ args, rawArgs: [] });
    return -1;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

/** Strips any stale index leftovers so the command builds a fresh one. */
function cloneRelatesFixture(): string {
  const clone = cloneFixture(RELATES_FIXTURE);
  rmSync(join(clone, ".spec-engine"), { recursive: true, force: true });
  return clone;
}

function makeEmptyPlatform(root: string): void {
  mkdirSync(join(root, "spec-engine"), { recursive: true });
}

describe("spec relations — relates-fixture content", () => {
  test("text mode emits a mermaid graph with nodes, labels, and deduped undirected edges", async () => {
    const clone = cloneRelatesFixture();
    try {
      const code = await runRelations({ platformDir: clone });
      expect(code).toBe(-1);
      const out = logs.join("\n");
      const lines = out.split("\n");
      expect(lines[0]).toBe("graph LR");
      // Fixture relations: REL-001→REL-003 (self-ref + dup dropped at parse),
      // REL-003→REL-002, REL-003→REL-999 (broken target, deliberately kept).
      expect(lines).toContain('  REL_001["REL-001"]');
      expect(lines).toContain('  REL_002["REL-002"]');
      expect(lines).toContain('  REL_003["REL-003"]');
      expect(lines).toContain('  REL_999["REL-999"]');
      expect(lines).toContain("  REL_001 --- REL_003");
      // Stored REL-003→REL-002 canonicalizes to (REL-002, REL-003).
      expect(lines).toContain("  REL_002 --- REL_003");
      expect(lines).toContain("  REL_003 --- REL_999");
      expect(out.match(/ --- /g)?.length).toBe(3);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  test("--json emits the sorted RelationRow[] array on stdout", async () => {
    const clone = cloneRelatesFixture();
    try {
      const code = await runRelations({ platformDir: clone, json: true });
      expect(code).toBe(-1);
      const jsonLine = logs.find((l) => l.startsWith("["));
      expect(jsonLine).toBeDefined();
      const rows = JSON.parse(jsonLine as string) as RelationRow[];
      expect(rows.map((r) => `${r.from_id}>${r.to_id}`)).toEqual([
        "REL-001>REL-003",
        "REL-003>REL-002",
        "REL-003>REL-999",
      ]);
      // Rows carry the Relates field's source location.
      expect(rows[0]?.source_file).toContain("SPEC.json");
      expect(rows[0]?.line).toBeGreaterThan(0);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describe("spec relations — empty platform", () => {
  test("text mode: actionable stderr message, no stdout, exit 0", async () => {
    makeEmptyPlatform(tmp);
    const code = await runRelations({ platformDir: tmp });
    expect(code).toBe(-1);
    expect(errs.some((m) => m.includes("No Relates links indexed"))).toBe(true);
    expect(errs.some((m) => m.includes(tmp))).toBe(true);
    expect(logs.length).toBe(0);
  });

  test("--json mode: stdout is exactly '[]' and NO message is emitted", async () => {
    makeEmptyPlatform(tmp);
    const code = await runRelations({ platformDir: tmp, json: true });
    expect(code).toBe(-1);
    const jsonLine = logs.find((l) => l.startsWith("["));
    expect(jsonLine).toBe("[]");
    expect(errs.some((m) => m.includes("No Relates links indexed"))).toBe(false);
  });
});

describe("spec relations — missing platform", () => {
  test("no spec-engine/ → friendly message (no stack trace) + exit 2", async () => {
    const code = await runRelations({ platformDir: tmp });
    expect(code).toBe(2);
    expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(true);
    expect(errs.some((m) => /\n\s+at\s/.test(m) || m.includes("    at "))).toBe(false);
  });
});

describe("spec relations — --out path containment", () => {
  test("--out resolving outside platformDir → exit 2 'must be inside platformDir'", async () => {
    makeEmptyPlatform(tmp);
    const code = await runRelations({ platformDir: tmp, out: join(tmp, "..", "evil.sqlite") });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/must be inside platformDir/);
  });
});
