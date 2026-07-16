// packages/engine/test/guard-steamroll.test.ts
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
// @spec GUARD-001
// @spec GUARD-002
// @spec GUARD-003
// @spec GUARD-004
// @spec GUARD-005
// @spec GUARD-006
// @spec GUARD-007
// @spec GUARD-008
// @spec GUARD-009

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardCommand } from "../src/commands/guard";
import { SPEC_TOKEN } from "./fixtures/specTag";

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
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

function billingJson(requirements: Array<Record<string, unknown>>): string {
  return `${JSON.stringify(
    { key: "BILLING", owner: "drea", specVersion: 1, updated: "2026-07-02", requirements },
    null,
    2,
  )}\n`;
}

function activeReq(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: "active",
    statement: `${id} statement`,
    why: null,
    supersedes: null,
    supersededBy: null,
    relates: [],
    livesIn: [],
    issues: [],
    ...extra,
  };
}

const BILLING_BASE = billingJson([activeReq("BILLING-001"), activeReq("BILLING-002")]);
const LEGAL_BASE = `${JSON.stringify(
  {
    key: "LEGAL",
    owner: "drea",
    specVersion: 1,
    updated: "2026-07-02",
    requirements: [activeReq("LEGAL-001")],
  },
  null,
  2,
)}\n`;

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

/** Build + commit the baseline: BILLING-001/002 + LEGAL-001, all Active,
 *  each with an implementing and a verifying tag. */
function buildBaseline(root: string): void {
  mkdirSync(join(root, "spec-engine", "BILLING"), { recursive: true });
  mkdirSync(join(root, "spec-engine", "LEGAL"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "spec-engine", "BILLING", "SPEC.json"), BILLING_BASE);
  writeFileSync(join(root, "spec-engine", "LEGAL", "SPEC.json"), LEGAL_BASE);
  writeFileSync(join(root, "src", "billing.ts"), SRC_BILLING);
  writeFileSync(join(root, "test", "billing.test.ts"), TEST_BILLING);
  writeFileSync(join(root, "src", "legal.ts"), SRC_LEGAL);
  writeFileSync(join(root, "test", "legal.test.ts"), TEST_LEGAL);
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

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "spec-guard-"));
  buildBaseline(repo);
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
    writeFileSync(
      join(repo, "spec-engine", "BILLING", "SPEC.json"),
      billingJson([activeReq("BILLING-002")]),
    );
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
        "Either run `spec supersede BILLING-001` with a successor, or stop and ask the user " +
        "whether this requirement should die.",
    );
  });
});

describe("spec guard — suppressions (GUARD-006/007)", () => {
  test("a same-change supersede suppresses the loss (GUARD-006)", async () => {
    // BILLING-002 → superseded by a new BILLING-003; drop its tags (retag worklist).
    writeFileSync(
      join(repo, "spec-engine", "BILLING", "SPEC.json"),
      billingJson([
        activeReq("BILLING-001"),
        activeReq("BILLING-002", { status: "superseded", supersededBy: "BILLING-003" }),
        activeReq("BILLING-003", { supersedes: "BILLING-002" }),
      ]),
    );
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

  test("an @spec approve directive suppresses the loss (GUARD-007)", async () => {
    // Delete BILLING-001, but acknowledge it with an in-diff approve comment.
    writeFileSync(
      join(repo, "spec-engine", "BILLING", "SPEC.json"),
      billingJson([activeReq("BILLING-002")]),
    );
    writeFileSync(
      join(repo, "src", "billing.ts"),
      `// billing implementation — ${approve("BILLING-001", "retired per user decision")}\nexport function refund() {} // ${tag("BILLING-002")}\n`,
    );
    const r = await runGuard({ platformDir: repo, json: true });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });
});

describe("spec guard — non-git graceful exit (GUARD-008)", () => {
  test("a non-git platform warns NOT_A_GIT_REPO on stderr and exits 0", async () => {
    const nongit = mkdtempSync(join(tmpdir(), "spec-guard-nongit-"));
    try {
      mkdirSync(join(nongit, "spec-engine", "BILLING"), { recursive: true });
      writeFileSync(join(nongit, "spec-engine", "BILLING", "SPEC.json"), BILLING_BASE);
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
    writeFileSync(
      join(repo, "spec-engine", "BILLING", "SPEC.json"),
      billingJson([activeReq("BILLING-002")]),
    );
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

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "spec-guard-nested-"));
    platform = join(parent, "app");
    mkdirSync(platform, { recursive: true });
    buildBaseline(platform);
    // buildBaseline runs `git init` in `platform`; re-home the repo at `parent`
    // so the platform is genuinely one level below the git root.
    rmSync(join(platform, ".git"), { recursive: true, force: true });
    // The platform's own .gitignore only ignores .spec-engine/ relative to it;
    // that's fine — write a repo-root .gitignore too for the parent-level repo.
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
    writeFileSync(
      join(platform, "spec-engine", "BILLING", "SPEC.json"),
      billingJson([activeReq("BILLING-002")]),
    );
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
