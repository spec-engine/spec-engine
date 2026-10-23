// The architecture fences (pure source-grep invariants) live once in
// scripts/arch-fences.sh and run here, inside `bun test`, so they execute on
// every supported platform, on pre-push, and are debuggable locally. Each
// fence carries its own positive/negative self-tests (see the script), so a
// regressed pattern fails loudly instead of silently passing.
//
// The script is spawned once; every test below reads that one run. A fence
// is identified by its `run` label.

import { beforeAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const FENCE_SCRIPT = join(REPO_ROOT, "scripts", "arch-fences.sh");

let exitCode = -1;
let stdout = "";
let stderr = "";

beforeAll(() => {
  const proc = Bun.spawnSync(["bash", FENCE_SCRIPT], { cwd: REPO_ROOT });
  exitCode = proc.exitCode;
  stdout = proc.stdout.toString();
  stderr = proc.stderr.toString();
});

/** The fence with this `run` label ran in this invocation and did not fail. */
function fenceHeld(label: string): void {
  expect(stdout).toContain(`── fence: ${label}\n`);
  expect(stdout).not.toContain(`FENCE FAILED: ${label}\n`);
}

describe("architecture fences (scripts/arch-fences.sh)", () => {
  test("every source-grep invariant holds on the current tree", () => {
    if (exitCode !== 0) {
      throw new Error(`architecture fences failed (exit ${exitCode}):\n${stdout}\n${stderr}`);
    }
    // Sanity: the script actually ran the fences (guards against a silent
    // no-op where bash couldn't find the file and still exited 0 somehow).
    expect(stdout).toContain("All architecture fences green.");
  });

  // @spec PROV-007 unit
  test("issue_id is never a key, index, join, or grouping column", () => {
    fenceHeld("issue_id is never an identity");
    expect(stdout).toContain("issue_id-opacity gate: OK");
  });

  // @spec DIST-024 unit
  test("publish runs on a v* tag or a release-please release, after every gate job", () => {
    fenceHeld("publish runs on release after every gate");
  });

  // @spec DIST-024 unit
  test("the release tag is checked against the package version before packing", () => {
    fenceHeld("tag and package version match before packing");
  });

  // @spec TRK-004 unit
  test("engine internals never import the tracker and carry no external host literal", () => {
    fenceHeld("engine internals never import the tracker or reach the network");
    expect(stdout).toContain("tracker import fence: OK");
  });

  // @spec TRK-007 unit
  test("the tracker package sends GraphQL queries only", () => {
    fenceHeld("tracker sends queries only");
  });

  // @spec TRK-009 unit
  test("the tracker never logs the token", () => {
    fenceHeld("token never logged");
  });

  // @spec INDX-013 unit
  test("no SPEC.md parse path exists in the engine", () => {
    fenceHeld("no SPEC.md parse path");
  });

  // @spec AUTHOR-015 unit
  test("the runner emits the llm-free engine fence OK marker", () => {
    fenceHeld("llm-free engine");
    expect(stdout).toContain("llm-free engine fence: OK");
  });

  // @spec CHCK-020 unit
  test("the committed GLOSSARY.md equals the generated one", () => {
    fenceHeld("glossary round-trip");
  });
});
