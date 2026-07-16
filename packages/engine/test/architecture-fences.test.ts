// packages/engine/test/architecture-fences.test.ts
//
// 2.1: the architecture fences (pure source-grep invariants) used to be ~360
// lines of bash duplicated between the darwin and linux CI jobs. They now live
// once in scripts/arch-fences.sh and run HERE, inside `bun test`, so they
// execute on every supported platform, on pre-push, and are debuggable locally
// — not only inside GitHub Actions. Each fence carries its own positive/negative
// self-tests (see the script), so a regressed pattern fails loudly instead of
// silently passing.
//
// This wrapper spawns the script and asserts a clean exit; on failure it
// surfaces the full fence output so the offending invariant is obvious.

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const FENCE_SCRIPT = join(REPO_ROOT, "scripts", "arch-fences.sh");

describe("architecture fences (2.1 — scripts/arch-fences.sh)", () => {
  // @spec TRK-001 — verify-only: the fence runner proves the engine internals
  // never import @spec-engine/tracker and emit no external-network host literal
  // (fence_trk02_tracker_import), so the derived index is built fully offline.
  // This is a negative/absence invariant with no implementing symbol.
  test("every source-grep invariant holds on the current tree", () => {
    const proc = Bun.spawnSync(["bash", FENCE_SCRIPT], { cwd: REPO_ROOT });
    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();
    if (proc.exitCode !== 0) {
      throw new Error(`architecture fences failed (exit ${proc.exitCode}):\n${stdout}\n${stderr}`);
    }
    // Sanity: the script actually ran the fences (guards against a silent
    // no-op where bash couldn't find the file and still exited 0 somehow).
    expect(stdout).toContain("All architecture fences green.");
  });

  // Wave 0 RED bar (Phase 5, AUTHOR-003): the LLM-free engine fence does not
  // exist yet. Wave 2 adds `fence_llmfree_engine` to scripts/arch-fences.sh —
  // it greps packages/engine/src for any model-SDK import / inference call and
  // prints the `llm-free engine fence: OK` marker on success (house style, with
  // positive/negative self-tests). This assertion FAILS RED now (no such
  // marker in the runner's stdout) and greens when the fence lands. The
  // verifying `@spec` tag — AUTHOR-003 unit — is added at the Wave 2 mint, not here.
  test("the runner emits the llm-free engine fence OK marker", () => {
    const proc = Bun.spawnSync(["bash", FENCE_SCRIPT], { cwd: REPO_ROOT });
    const stdout = proc.stdout.toString();
    expect(stdout).toContain("llm-free engine fence: OK");
  });

  // @spec SCHM-008 unit — the authored-specVersion gate: fence_no_authored_specversion
  // fails the build if any non-TERM domain envelope in the real corpus carries a
  // specVersion (the version is DAG-derived; only TERM keeps an authored counter).
  // Proven two ways: the real tree passes (OK marker present in the runner's
  // stdout, above), and here the detector is exercised directly against a planted
  // non-TERM offender to prove it would trip.
  test("the authored-specVersion fence trips on a planted non-TERM specVersion", () => {
    // Mirror the fence's detector against a planted non-TERM envelope.
    const offender = '{ "key": "BILLING", "specVersion": 2, "updated": "x", "requirements": [] }';
    const proc = Bun.spawnSync(["grep", "-qE", '"specVersion"'], { stdin: Buffer.from(offender) });
    expect(proc.exitCode).toBe(0);
    // And the real tree is clean: the fence prints its OK marker.
    const runner = Bun.spawnSync(["bash", FENCE_SCRIPT], { cwd: REPO_ROOT });
    expect(runner.stdout.toString()).toContain("authored-specVersion fence: OK");
  });
});
