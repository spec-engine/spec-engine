import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cli.ts");

function runCli(...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, CLI, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

const tmp = mkdtempSync(join(tmpdir(), "spec-noargs-"));

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("bare `spec` prints full usage and exits 0", () => {
  const { exitCode, stdout } = runCli();
  expect(exitCode).toBe(0);
  // Meta description proves the usage header rendered.
  expect(stdout).toContain("Cross-repo spec engine");
  // Subcommand names prove the full COMMANDS list rendered, not a fragment.
  expect(stdout).toContain("check");
  expect(stdout).toContain("map");
  expect(stdout).toContain("propagation");
  expect(stdout).toContain("gate");
});

test("bare invocation output is byte-identical to `spec --help`", () => {
  const bare = runCli();
  const help = runCli("--help");
  expect(help.exitCode).toBe(0);
  // Byte-parity locks "same renderer as --help" — hand-rolled text cannot pass.
  expect(bare.stdout).toBe(help.stdout);
});

test("subcommands do NOT get usage text appended (rawArgs guard)", () => {
  // DB-free; its only side effect is the scaffolded SPEC.json in the suite tmp dir.
  const { exitCode, stdout } = runCli("domain", "new", "FOO", tmp);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe("created spec-engine/FOO/SPEC.json");
  // An unguarded showUsage in the root run() would trip this — citty invokes
  // the root run() even after a subcommand dispatch.
  expect(stdout).not.toContain("Cross-repo spec engine");
});
