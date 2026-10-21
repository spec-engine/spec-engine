// @spec GUARD-024 unit
// @spec GUARD-025 unit
// @spec GUARD-026 unit

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Diagnostic } from "@spec-engine/shared";
import { TestPlatform } from "../testing/platform";
import { SPEC_TOKEN } from "../testing/specTag";
import { withIndex } from "./_index";
import { check } from "./check";

const tag = (id: string, level?: string): string =>
  `${SPEC_TOKEN} ${id}${level ? ` ${level}` : ""}`;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
}

let repo: string;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "spec-check-losses-"));
  const fx = TestPlatform.at(repo);
  await (await fx.domain("BILLING", { owner: "drea" })).req();
  await (await fx.domain("LEGAL", { owner: "drea" })).req();
  fx.file("src/billing.ts", `export function charge() {} // ${tag("BILLING-001")}\n`);
  fx.file("test/billing.test.ts", `it("charges", () => {}); // ${tag("BILLING-001", "unit")}\n`);
  writeFileSync(join(repo, ".gitignore"), ".spec-engine/\n");
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "baseline");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

async function runCheck(base?: string): Promise<{ rows: Diagnostic[]; failing: boolean }> {
  return withIndex({ platformDir: repo, build: "reset" }, async (h) => {
    const r = await check({ platformDir: repo, base }, h.storage);
    if (!r.ok) throw new Error(r.detail);
    return { rows: r.diagnostics, failing: r.failing };
  });
}

const lossRows = (rows: Diagnostic[]) =>
  rows.filter((d) => ["IMPL_LOST", "VERIFY_LOST", "SPEC_FILE_DELETED"].includes(d.code));

describe("spec check reports guard's losses", () => {
  test("an unchanged tree reports no loss", async () => {
    expect(lossRows((await runCheck()).rows)).toEqual([]);
  });

  test("losing the last implementing tag is an IMPL_LOST error against HEAD", async () => {
    writeFileSync(join(repo, "src", "billing.ts"), "export function charge() {}\n");
    const { rows, failing } = await runCheck();
    expect(lossRows(rows)).toEqual([
      expect.objectContaining({
        code: "IMPL_LOST",
        severity: "error",
        req_id: "BILLING-001",
        source_file: "src/billing.ts",
        repo: null,
      }),
    ]);
    expect(failing).toBe(true);
  });

  test("losing the last verifying tag is a VERIFY_LOST warning against --base", async () => {
    writeFileSync(join(repo, "test", "billing.test.ts"), 'it("charges", () => {});\n');
    const { rows } = await runCheck("HEAD");
    expect(lossRows(rows)).toEqual([
      expect.objectContaining({ code: "VERIFY_LOST", severity: "warning", req_id: "BILLING-001" }),
    ]);
  });

  test("a deleted spec file is a SPEC_FILE_DELETED error and its removal is reported once", async () => {
    rmSync(join(repo, "spec-engine", "LEGAL", "SPEC.json"));
    const { rows } = await runCheck();
    expect(lossRows(rows)).toEqual([
      expect.objectContaining({
        code: "SPEC_FILE_DELETED",
        severity: "error",
        req_id: null,
        source_file: "spec-engine/LEGAL/SPEC.json",
      }),
    ]);
    expect(rows.filter((d) => d.code === "REQUIREMENT_REMOVED").map((d) => d.req_id)).toEqual([
      "LEGAL-001",
    ]);
  });
});
