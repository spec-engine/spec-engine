// packages/engine/src/commands/guard.test.ts
//
// End-to-end coverage for `spec guard` (commands/guard.ts) against a REAL temp
// git repo — the steamroll scenario the build brief asks for: an Active
// requirement committed with its @spec tags and tests, then gutted in the
// working tree, is caught by diffing HEAD's derivation against the worktree.
//
// The repo is a single-repo self-member (spec-engine/ + a manifest + code in
// src/ + test/ subdirs, no sibling members — mirrors single-repo-fixture) so
// its own code tags are indexed. The command is invoked IN PROCESS with
// process.exit stubbed to throw (the cli-check-unit.test.ts pattern), so the
// runner can assert on the exit code.
//
// Verifies:
// @spec GUARD-013
// @spec GUARD-023
// @spec GUARD-015
// @spec GUARD-016
// @spec GUARD-017
// @spec GUARD-018
// @spec GUARD-019
// @spec GUARD-020
// @spec GUARD-022

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryOf, plantEdit } from "../testing/plant";
import { TestPlatform } from "../testing/platform";
import { SPEC_TOKEN } from "../testing/specTag";
import { guardCommand } from "./guard";

// Build tag/approve tokens at RUNTIME so no literal `@spec <ID>` appears in this
// test's source — the self-member scanner would otherwise index these fixture
// strings as real (dangling) tags of THIS repo (see fixtures/specTag.ts).
const tag = (id: string, level?: string): string =>
  `${SPEC_TOKEN} ${id}${level ? ` ${level}` : ""}`;
const approve = (id: string, reason: string): string => `${SPEC_TOKEN} approve ${id} ${reason}`;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "spec-check Test",
  GIT_AUTHOR_EMAIL: "test@spec.local",
  GIT_COMMITTER_NAME: "spec-check Test",
  GIT_COMMITTER_EMAIL: "test@spec.local",
};

function git(cwd: string, ...args: string[]): void {
  if (!cwd) throw new Error("git helper needs a cwd; refusing to run in the process cwd");
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

/** Drop one entry from the working-tree BILLING file (the engine refuses this; the guard must catch it). */
function removeBilling(root: string, id: string): Promise<void> {
  return plantEdit(root, "BILLING", (dom) => {
    dom.requirements = dom.requirements.filter((r) => r.id !== id);
  });
}

const SRC_BILLING = `// billing implementation
export function charge() {} // ${tag("BILLING-001")}
export function refund() {} // ${tag("BILLING-002")}
`;
const TEST_BILLING = `// billing tests
it("charges", () => {}); // ${tag("BILLING-001", "unit")}
it("refunds", () => {}); // ${tag("BILLING-002", "unit")}
`;
const SRC_LEGAL = `export function terms() {} // ${tag("LEGAL-001")}\n`;
const TEST_LEGAL = `it("terms", () => {}); // ${tag("LEGAL-001", "unit")}\n`;

let repo: string;

/** Author the baseline tree: BILLING-001/002 + LEGAL-001, all Active, each
 *  with an implementing and a verifying tag. No git. */
async function writeBaseline(root: string): Promise<void> {
  const fx = TestPlatform.at(root);
  const billing = await fx.domain("BILLING", { owner: "drea" });
  await billing.reqs(2);
  const legal = await fx.domain("LEGAL", { owner: "drea" });
  await legal.req();
  fx.file("src/billing.ts", SRC_BILLING);
  fx.file("test/billing.test.ts", TEST_BILLING);
  fx.file("src/legal.ts", SRC_LEGAL);
  fx.file("test/legal.test.ts", TEST_LEGAL);
}

/** Author + commit the baseline as its own repository. */
async function buildBaseline(root: string): Promise<void> {
  await writeBaseline(root);
  writeFileSync(join(root, ".gitignore"), ".spec-engine/\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "baseline");
}

// --- in-process command harness (process.exit stubbed to throw) --------------

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const guardRun = (guardCommand as unknown as { run: RunFn }).run;

let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

async function runGuard(
  args: Record<string, unknown>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  logs = [];
  errs = [];
  let code = -1;
  try {
    await guardRun({ args, rawArgs: [] });
  } catch (e) {
    if (e instanceof ExitError) code = e.code;
    else throw e;
  }
  return { code, stdout: logs.join("\n"), stderr: errs.join("\n") };
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "spec-guard-"));
  await buildBaseline(repo);
  originalLog = console.log;
  originalErr = console.error;
  originalExit = process.exit;
  console.log = (...a: unknown[]) => {
    logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  };
  console.error = (...a: unknown[]) => {
    errs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  };
  (process as unknown as { exit: (code?: number) => never }).exit = (c?: number) => {
    throw new ExitError(c ?? 0);
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  rmSync(repo, { recursive: true, force: true });
});

describe("spec guard — clean + exit contract (GUARD-001)", () => {
  test("an unmodified working tree reports no losses and exits 0", async () => {
    const r = await runGuard({ platformDir: repo, json: true });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });
});

describe("spec guard — loss classes (GUARD-002..005)", () => {
  test("REQUIREMENT_REMOVED: dropping BILLING-001 from the spec is a loss, exit 1 (GUARD-002)", async () => {
    // Remove BILLING-001 from the domain (BILLING-002 survives so the file stays).
    await removeBilling(repo, "BILLING-001");
    const r = await runGuard({ platformDir: repo, json: true });
    expect(r.code).toBe(1);
    const rows = JSON.parse(r.stdout) as Array<{ kind: string; req_id: string }>;
    expect(rows).toEqual([
      expect.objectContaining({ kind: "REQUIREMENT_REMOVED", req_id: "BILLING-001" }),
    ]);
  });

  test("IMPL_LOST: removing the only implementing tag is a loss (GUARD-003)", async () => {
    // Drop the BILLING-001 impl tag from src; keep the req + its test.
    writeFileSync(
      join(repo, "src", "billing.ts"),
      `// billing implementation\nexport function charge() {}\nexport function refund() {} // ${tag("BILLING-002")}\n`,
    );
    const r = await runGuard({ platformDir: repo, json: true });
    expect(r.code).toBe(1);
    const rows = JSON.parse(r.stdout) as Array<{ kind: string; req_id: string; file: string }>;
    expect(rows).toEqual([
      expect.objectContaining({ kind: "IMPL_LOST", req_id: "BILLING-001", file: "src/billing.ts" }),
    ]);
  });

  test("VERIFY_LOST: removing the only verifying tag is a loss (GUARD-004)", async () => {
    writeFileSync(
      join(repo, "test", "billing.test.ts"),
      `// billing tests\nit("charges", () => {});\nit("refunds", () => {}); // ${tag("BILLING-002", "unit")}\n`,
    );
    const r = await runGuard({ platformDir: repo, json: true });
    expect(r.code).toBe(1);
    const rows = JSON.parse(r.stdout) as Array<{ kind: string; req_id: string }>;
    expect(rows).toEqual([expect.objectContaining({ kind: "VERIFY_LOST", req_id: "BILLING-001" })]);
  });

  test("SPEC_FILE_DELETED: deleting a whole domain file is a loss (GUARD-005)", async () => {
    rmSync(join(repo, "spec-engine", "LEGAL", "SPEC.json"));
    const r = await runGuard({ platformDir: repo, json: true });
    expect(r.code).toBe(1);
    const kinds = (JSON.parse(r.stdout) as Array<{ kind: string }>).map((x) => x.kind);
    expect(kinds).toContain("SPEC_FILE_DELETED");
  });

  test("gutting impl+test for a surviving Active req prints the exact product block", async () => {
    writeFileSync(
      join(repo, "src", "billing.ts"),
      `// billing implementation\nexport function charge() {}\nexport function refund() {} // ${tag("BILLING-002")}\n`,
    );
    writeFileSync(
      join(repo, "test", "billing.test.ts"),
      `// billing tests\nit("charges", () => {});\nit("refunds", () => {}); // ${tag("BILLING-002", "unit")}\n`,
    );
    const r = await runGuard({ platformDir: repo });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "🛑 spec-guard: BILLING-001 is Active and this change deletes its only implementation (src/billing.ts:",
    );
    expect(r.stdout).toContain(
      "and its verifying test. Requirements are superseded, never deleted. " +
        "Either run `spec supersede BILLING-001` with a successor, or run " +
        "`spec deprecate BILLING-001 " +
        '--reason "..."` to end it with a recorded reason.',
    );
  });
});

describe("spec guard — suppressions (GUARD-006/007)", () => {
  test("a same-change supersede suppresses the loss (GUARD-006)", async () => {
    // BILLING-002 → superseded by a new BILLING-003; drop its tags (retag worklist).
    const { newId } = await TestPlatform.at(repo).handle("BILLING").supersede("BILLING-002");
    expect(newId).toBe("BILLING-003");
    await plantEdit(repo, "BILLING", (dom) => {
      entryOf(dom, newId).supersedes = "BILLING-002";
    });
    writeFileSync(
      join(repo, "src", "billing.ts"),
      `// billing implementation\nexport function charge() {} // ${tag("BILLING-001")}\nexport function renew() {} // ${tag("BILLING-003")}\n`,
    );
    writeFileSync(
      join(repo, "test", "billing.test.ts"),
      `// billing tests\nit("charges", () => {}); // ${tag("BILLING-001", "unit")}\nit("renews", () => {}); // ${tag("BILLING-003", "unit")}\n`,
    );
    const r = await runGuard({ platformDir: repo, json: true });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  test("no override comment exists: an in-diff acknowledgement does NOT suppress the loss (GUARD-012)", async () => {
    // Delete BILLING-001 and leave an approve-style comment in the diff — the
    // escape hatch is gone; the deletion is still reported.
    await removeBilling(repo, "BILLING-001");
    writeFileSync(
      join(repo, "src", "billing.ts"),
      `// billing implementation — ${approve("BILLING-001", "acknowledged")}\nexport function refund() {} // ${tag("BILLING-002")}\n`,
    );
    const r = await runGuard({ platformDir: repo, json: true });
    expect(r.code).toBe(1);
    const losses = JSON.parse(r.stdout) as Array<{ kind: string; req_id: string }>;
    expect(losses.some((l) => l.kind === "REQUIREMENT_REMOVED" && l.req_id === "BILLING-001")).toBe(
      true,
    );
  });
});

describe("spec guard — non-git graceful exit (GUARD-008)", () => {
  test("a non-git platform warns NOT_A_GIT_REPO on stderr and exits 0", async () => {
    const nongit = mkdtempSync(join(tmpdir(), "spec-guard-nongit-"));
    try {
      const billing = await TestPlatform.at(nongit).domain("BILLING", { owner: "drea" });
      await billing.reqs(2);
      const r = await runGuard({ platformDir: nongit, json: true });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("NOT_A_GIT_REPO");
      expect(r.stdout).toBe("[]");
    } finally {
      rmSync(nongit, { recursive: true, force: true });
    }
  });
});

describe("spec guard — deterministic --json (GUARD-009)", () => {
  test("identical mutation → byte-identical JSON across runs", async () => {
    await removeBilling(repo, "BILLING-001");
    const a = await runGuard({ platformDir: repo, json: true });
    const b = await runGuard({ platformDir: repo, json: true });
    expect(a.stdout).toBe(b.stdout);
    expect(a.code).toBe(1);
  });
});

describe("spec guard — platform nested below the git root (1.2)", () => {
  // Regression for the fail-open bug: when the platform lives in a subdirectory
  // of a larger repo, git returns repo-root-relative paths. Before the fix the
  // `spec-engine/` filter matched nothing, the guard saw zero changes, and a
  // deleted requirement passed silently. The git seam now translates through the
  // repo prefix so the nested platform classifies its changes correctly.
  let parent: string;
  let platform: string;

  beforeEach(async () => {
    parent = mkdtempSync(join(tmpdir(), "spec-guard-nested-"));
    platform = join(parent, "app");
    mkdirSync(platform, { recursive: true });
    // The platform is written without its own repository: an inner `git init`
    // followed by deleting `app/.git` races the detached maintenance process a
    // commit can leave behind, which recreates `app/.git` and turns `app` into
    // an embedded repo with no commits at the parent's `git add -A`.
    await writeBaseline(platform);
    writeFileSync(join(parent, ".gitignore"), "app/.spec-engine/\n");
    git(parent, "init", "-q");
    git(parent, "add", "-A");
    git(parent, "commit", "-q", "-m", "baseline");
  });

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  test("a clean nested tree reports no losses and exits 0", async () => {
    const r = await runGuard({ platformDir: platform, json: true });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  test("REQUIREMENT_REMOVED is detected when the platform is nested (no longer fails open)", async () => {
    await removeBilling(platform, "BILLING-001");
    const r = await runGuard({ platformDir: platform, json: true });
    expect(r.code).toBe(1);
    const rows = JSON.parse(r.stdout) as Array<{ kind: string; req_id: string }>;
    expect(rows).toEqual([
      expect.objectContaining({ kind: "REQUIREMENT_REMOVED", req_id: "BILLING-001" }),
    ]);
  });

  test("IMPL_LOST reports a platform-relative file path when nested", async () => {
    writeFileSync(
      join(platform, "src", "billing.ts"),
      `// billing implementation\nexport function charge() {}\nexport function refund() {} // ${tag("BILLING-002")}\n`,
    );
    const r = await runGuard({ platformDir: platform, json: true });
    expect(r.code).toBe(1);
    const rows = JSON.parse(r.stdout) as Array<{ kind: string; req_id: string; file: string }>;
    expect(rows).toEqual([
      expect.objectContaining({ kind: "IMPL_LOST", req_id: "BILLING-001", file: "src/billing.ts" }),
    ]);
  });
});
