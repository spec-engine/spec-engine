// packages/engine/test/cli-domain.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec DOMAIN-001
// @spec DOMAIN-002
// @spec DOMAIN-003
// @spec DOMAIN-010
// @spec DOMAIN-005
// @spec DOMAIN-006
// @spec DOMAIN-007
// @spec DOMAIN-008
// @spec DOMAIN-009
//
// `spec domain new <name> [platformDir]` scaffolds a starter SPEC.md with input
// normalization; `spec domain list [platformDir]` prints sorted domain
// keys read from the filesystem (canonical truth — never the derived index).
//
// Behaviors asserted (AUTHC IDs):
//   - AUTHC-001/002 — normalization (uppercase + strip whitespace, NEVER
//     dashes) and the exactly-once normalization message.
//   - AUTHC-003 — post-normalization KEY_RE enforcement, exit 2.
//   - AUTHC-004 — scaffold shape: a JSON domain envelope
//     `{ key, owner:null, specVersion:1, updated:<localToday>, requirements:[] }`
//     written through the ONE validateAndWrite seam (SPEC.json, byte-stable).
//   - AUTHC-005 — refuse-to-overwrite, exit 2.
//   - AUTHC-007/008 — domain list: filesystem-derived, sorted, empty → exit 0.
//   - AUTHC-009 — domain list on a non-platform dir → friendly message, exit 2.
//
// process.exit() is captured by replacing it with a thrown sentinel so the
// test asserts on the exit code instead of terminating the test runner
// (pattern carried from the retired cli-new.test.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domainListCommand, domainNewCommand } from "../src/commands/domain";

/** Today's date in the LOCAL timezone (WR-05 — NEVER toISOString, which rolls
 *  forward at UTC midnight). Mirrors authoring/edit.ts localToday(). */
function localToday(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}

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
  tmp = mkdtempSync(join(tmpdir(), "spec-cli-domain-"));
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
  // process.exit is typed as `(code?: number) => never`; the stub throws so
  // callers can `try { ... } catch (ExitError) { ... }` instead of
  // terminating the test runner. Cast through unknown to a writable property.
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

// citty's defineCommand returns a generic CommandDef whose `.run` is loosely
// typed; cast through `unknown` to a minimal local shape rather than `any`.
type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const newRun = (domainNewCommand as unknown as { run: RunFn }).run;
const listRun = (domainListCommand as unknown as { run: RunFn }).run;

async function runDomainNew(name: string, platformDir: string): Promise<void> {
  await newRun({ args: { name, platformDir }, rawArgs: [] });
}

async function runDomainList(platformDir: string): Promise<void> {
  await listRun({ args: { platformDir }, rawArgs: [] });
}

async function expectExit2(fn: () => Promise<void>): Promise<void> {
  let caught: ExitError | null = null;
  try {
    await fn();
  } catch (e) {
    if (e instanceof ExitError) caught = e;
    else throw e;
  }
  expect(caught).not.toBeNull();
  expect(caught?.code).toBe(2);
}

describe("spec domain new — normalization (AUTHC-001/002)", () => {
  test("lowercase `auth` normalizes to AUTH and scaffolds it", async () => {
    await runDomainNew("auth", tmp);
    expect(existsSync(join(tmp, "spec-engine", "AUTH", "SPEC.json"))).toBe(true);
  });

  test("mixed-case `aUtH` normalizes to AUTH", async () => {
    await runDomainNew("aUtH", tmp);
    expect(existsSync(join(tmp, "spec-engine", "AUTH", "SPEC.json"))).toBe(true);
  });

  test("`user auth` strips the space → USERAUTH (NEVER a dash)", async () => {
    await runDomainNew("user auth", tmp);
    const dest = join(tmp, "spec-engine", "USERAUTH", "SPEC.json");
    expect(existsSync(dest)).toBe(true);
    // The dashed form must NOT exist — a dash is the id key/seq separator and
    // a dashed key is rejected by the schema (KEY_RE) at author time.
    expect(existsSync(join(tmp, "spec-engine", "USER-AUTH"))).toBe(false);
    const obj = JSON.parse(await Bun.file(dest).text());
    expect(obj.key).toBe("USERAUTH");
    expect(obj.requirements).toEqual([]);
  });

  test("normalization message printed exactly once for changed input", async () => {
    await runDomainNew("user auth", tmp);
    const matches = logs.filter((l) => l === 'spec domain: normalized "user auth" → USERAUTH');
    expect(matches.length).toBe(1);
  });

  test("NO normalization message for already-canonical input", async () => {
    await runDomainNew("AUTH", tmp);
    expect(logs.some((l) => l.includes("normalized"))).toBe(false);
    expect(existsSync(join(tmp, "spec-engine", "AUTH", "SPEC.json"))).toBe(true);
  });
});

describe("spec domain new — scaffold shape (AUTHC-004)", () => {
  // @spec DOMAIN-010 — a requirement (non-TERM) domain scaffolds WITHOUT an
  // authored specVersion (its version is DAG-derived, SCHM-007/008).
  test("scaffold is a JSON envelope with the canonical empty shape (no specVersion)", async () => {
    await runDomainNew("VALID", tmp);
    const raw = await Bun.file(join(tmp, "spec-engine", "VALID", "SPEC.json")).text();
    // Byte-stable: 2-space indent + exactly one trailing newline (validateAndWrite).
    expect(raw.endsWith("}\n")).toBe(true);
    const obj = JSON.parse(raw);
    // CHRT-003: `scope` is now a canonical envelope key. orderDomain normalizes
    // an unauthored charter to `scope: null` (mirroring `owner`), so a fresh
    // scaffold carries an explicit null charter.
    expect(obj).toEqual({
      key: "VALID",
      owner: null,
      updated: localToday(),
      scope: null,
      requirements: [],
    });
    expect("specVersion" in obj).toBe(false);
  });

  // @spec DOMAIN-010 — the reserved TERM domain is the sole exception: it IS
  // seeded with specVersion 1 (its authored counter is the term-drift pin).
  test("the reserved TERM domain scaffolds WITH specVersion 1", async () => {
    await runDomainNew("TERM", tmp);
    const obj = JSON.parse(await Bun.file(join(tmp, "spec-engine", "TERM", "SPEC.json")).text());
    expect(obj.specVersion).toBe(1);
  });

  test("scaffold is written through the seam (no Markdown SPEC.md left behind)", async () => {
    await runDomainNew("VALID", tmp);
    expect(existsSync(join(tmp, "spec-engine", "VALID", "SPEC.json"))).toBe(true);
    expect(existsSync(join(tmp, "spec-engine", "VALID", "SPEC.md"))).toBe(false);
  });

  test("prints created SPEC.json path", async () => {
    await runDomainNew("VALID", tmp);
    expect(logs.some((l) => l.includes("created") && l.includes("VALID/SPEC.json"))).toBe(true);
  });
});

describe("spec domain new — KEY validation after normalization (AUTHC-003)", () => {
  test("leading digit (9lives) rejected with exit 2", async () => {
    await expectExit2(() => runDomainNew("9lives", tmp));
    expect(errs.some((m) => m.includes("KEY must match"))).toBe(true);
    expect(existsSync(join(tmp, "spec-engine", "9LIVES"))).toBe(false);
  });

  test("whitespace-only input (empty after normalization) rejected with exit 2", async () => {
    await expectExit2(() => runDomainNew("  ", tmp));
    expect(errs.some((m) => m.includes("KEY must match"))).toBe(true);
  });

  test("punctuation (a.b/c) rejected with exit 2", async () => {
    await expectExit2(() => runDomainNew("a.b/c", tmp));
    expect(errs.some((m) => m.includes("KEY must match"))).toBe(true);
  });
});

describe("spec domain new — refuse to overwrite (AUTHC-005)", () => {
  test("second invocation on same key exits 2 with refusing-to-overwrite", async () => {
    await runDomainNew("DUP", tmp);
    await expectExit2(() => runDomainNew("DUP", tmp));
    expect(errs.some((m) => m.includes("refusing to overwrite"))).toBe(true);
  });

  // WR-03: a fresh empty SPEC.json beside an existing SPEC.md would shadow the
  // Markdown on the prefer-JSON index — silent data loss. The guard must refuse.
  test("refuses when a sibling SPEC.md already exists (WR-03) — no SPEC.json written", async () => {
    const dir = join(tmp, "spec-engine", "LEGACY");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SPEC.md"),
      "---\nkey: LEGACY\nspec_version: 1\nupdated: 2026-06-02\n---\n\n### LEGACY-001 — Active\n**Requirement:** Existing truth.\n",
    );
    await expectExit2(() => runDomainNew("LEGACY", tmp));
    expect(errs.some((m) => m.includes("already exists") && m.includes("SPEC.md"))).toBe(true);
    // The Markdown was NOT shadowed by a fresh empty JSON.
    expect(existsSync(join(dir, "SPEC.json"))).toBe(false);
  });
});

describe("spec domain list (AUTHC-007/008/009)", () => {
  test("prints keys sorted lexicographically, one per line", async () => {
    // Scaffold deliberately out of lexical order.
    await runDomainNew("ZULU", tmp);
    await runDomainNew("ALPHA", tmp);
    await runDomainNew("MIKE", tmp);
    logs.length = 0; // drop the scaffold "created ..." lines
    await runDomainList(tmp);
    expect(logs).toEqual(["ALPHA", "MIKE", "ZULU"]);
  });

  test("empty spec-engine/ → exit 0, zero output lines", async () => {
    mkdirSync(join(tmp, "spec-engine"), { recursive: true });
    await runDomainList(tmp);
    expect(logs).toEqual([]);
  });

  test("non-platform dir → exit 2 with friendly message", async () => {
    await expectExit2(() => runDomainList(tmp));
    expect(errs.some((m) => m.includes("is not a spec-check platform"))).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// D-08 — the authoring path stays bun:sqlite-free. The import-count rule is a
// dev convention (AGENTS.md + the D-08 CI fence, fence_d08_engine_internal),
// not a spec-engine requirement; this in-suite arch test is its dogfood.
// ----------------------------------------------------------------------------

describe("D-08 — zero bun:sqlite imports in the authoring path", () => {
  test("commands/domain.ts, commands/req.ts, authoring/domains.ts import zero bun:sqlite", async () => {
    // Same import shapes as the CI grep-fence (comments MAY mention the
    // module name — the fence is about the dependency edge, not prose).
    const importRe = /(from\s+["']bun:sqlite["']|require\(\s*["']bun:sqlite["']\s*\))/;
    for (const rel of ["commands/domain.ts", "commands/req.ts", "authoring/domains.ts"]) {
      const src = await Bun.file(join(import.meta.dir, "..", "src", rel)).text();
      expect(importRe.test(src)).toBe(false);
    }
  });
});

// ----------------------------------------------------------------------------
// CHRT-004 — `spec domain list --json`: a sorted array of `{ key, scope }`
// objects (a breaking shape change from the old flat `string[]`). scope is read
// per-key from the filesystem SPEC.json — null when a domain has no charter,
// `[]` when there are none. Verifies the CHRT-004 emit site in commands/domain.ts.
// @spec CHRT-004 unit
// ----------------------------------------------------------------------------

describe("spec domain list --json — machine mode (CHRT-004)", () => {
  /** Write a schema-valid SPEC.json for `key`, optionally carrying a charter. */
  function writeDomainJson(key: string, scope: string | null): void {
    mkdirSync(join(tmp, "spec-engine", key), { recursive: true });
    const env: Record<string, unknown> = {
      key,
      owner: null,
      specVersion: 1,
      updated: "2026-07-01",
      requirements: [],
    };
    if (scope !== null) env.scope = scope;
    writeFileSync(join(tmp, "spec-engine", key, "SPEC.json"), `${JSON.stringify(env, null, 2)}\n`);
  }

  test("emits a sorted array of {key, scope} objects — charter when present, null when absent", async () => {
    // Written out of lexical order; GUARD carries a charter, POC does not.
    writeDomainJson("POC", null);
    writeDomainJson("GUARD", "guard the loss gate");
    await listRun({ args: { platformDir: tmp, json: true }, rawArgs: [] });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual([
      { key: "GUARD", scope: "guard the loss gate" },
      { key: "POC", scope: null },
    ]);
  });

  test("a domain dir with an absent/malformed SPEC.json degrades to scope: null (no throw)", async () => {
    writeDomainJson("GOOD", "has a charter");
    // A domain dir whose SPEC.json is present-but-malformed must not crash the
    // listing — it degrades to scope: null (structural reject is `spec check`).
    mkdirSync(join(tmp, "spec-engine", "BROKE"), { recursive: true });
    writeFileSync(join(tmp, "spec-engine", "BROKE", "SPEC.json"), "{ not valid json");
    await listRun({ args: { platformDir: tmp, json: true }, rawArgs: [] });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toEqual([
      { key: "BROKE", scope: null },
      { key: "GOOD", scope: "has a charter" },
    ]);
  });

  test("zero domains emits an empty JSON array", async () => {
    mkdirSync(join(tmp, "spec-engine"), { recursive: true });
    await listRun({ args: { platformDir: tmp, json: true }, rawArgs: [] });
    expect(logs).toEqual(["[]"]);
  });
});
