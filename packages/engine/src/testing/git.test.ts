import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAndTag } from "./git";

let bare: string;
let work: string;
const saved = process.env.GIT_DIR;

const refsOf = (gitDir: string, cwd: string): string =>
  Bun.spawnSync(["git", "--git-dir", gitDir, "for-each-ref"], { cwd }).stdout.toString();

beforeEach(() => {
  bare = mkdtempSync(join(tmpdir(), "spec-git-bare-"));
  work = mkdtempSync(join(tmpdir(), "spec-git-work-"));
  Bun.spawnSync(["git", "init", "-q", "--bare", bare]);
});

afterEach(() => {
  if (saved === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = saved;
  rmSync(bare, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

test("an inherited GIT_DIR does not receive the helper's commit or tag", () => {
  process.env.GIT_DIR = bare;
  commitAndTag(work, "v1.0.0");
  delete process.env.GIT_DIR;
  expect(refsOf(bare, work)).toBe("");
  expect(refsOf(join(work, ".git"), work)).toContain("refs/tags/v1.0.0");
});
