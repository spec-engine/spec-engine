// packages/engine/test/cli-noargs.test.ts
//
// RED-10: bare `spec` (zero args) must print the full help/usage text and
// exit 0 — discovered via citty's built-in showUsage renderer, locked here
// by byte-parity with `--help`. A third test locks the rawArgs guard:
// citty fires the root run() after subcommand dispatch too, so an unguarded
// showUsage would append usage text to every subcommand's output.
//
// Subprocess pattern follows schema-version.test.ts: spawn the real
// entrypoint with the running bun binary (process.execPath).

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");

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

test("RED-10: bare `spec` prints full usage and exits 0", () => {
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

test("RED-10: bare invocation output is byte-identical to `spec --help`", () => {
  const bare = runCli();
  const help = runCli("--help");
  expect(help.exitCode).toBe(0);
  // Byte-parity locks "same renderer as --help" — hand-rolled text cannot pass.
  expect(bare.stdout).toBe(help.stdout);
});

test("RED-10 guard: subcommands do NOT get usage text appended (rawArgs guard)", () => {
  // `spec domain new FOO <tmpdir>` is DB-free (no .spec-engine/ artifact) and its
  // only side effect is contained in the per-suite tmp dir: it scaffolds
  // <tmpdir>/spec-engine/FOO/SPEC.json (17-04 JSON write format), prints the
  // created path, exits 0.
  const { exitCode, stdout } = runCli("domain", "new", "FOO", tmp);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe("created spec-engine/FOO/SPEC.json");
  // An unguarded showUsage in the root run() would trip this — citty invokes
  // the root run() even after a subcommand dispatch.
  expect(stdout).not.toContain("Cross-repo spec engine");
});
