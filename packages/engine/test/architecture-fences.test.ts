// packages/engine/test/architecture-fences.test.ts
//
// The architecture fences (pure source-grep invariants) live once in
// scripts/arch-fences.sh and run here, inside `bun test`, so they execute on
// every supported platform, on pre-push, and are debuggable locally. Each
// fence carries its own positive/negative self-tests (see the script), so a
// regressed pattern fails loudly instead of silently passing.
//
// The script is spawned once; every test below reads that one run. A fence
// is identified by the requirement id its `run` label starts with, which is
// also the `@spec` tag on the fence function.

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

/** The fence labelled with `id` ran in this invocation and did not fail. */
function fenceHeld(id: string): void {
  expect(stdout).toContain(`── fence: ${id} `);
  expect(stdout).not.toContain(`FENCE FAILED: ${id} `);
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

  // @spec SCHM-025 unit
  test("SCHM-025: bun:sqlite is imported from storage/sqlite.ts and nowhere else", () => {
    fenceHeld("SCHM-025");
    expect(stdout.match(/── fence: SCHM-025 /g)).toHaveLength(2);
  });

  // @spec SCHM-026 unit
  test("SCHM-026: every SPEC.json write, tests included, goes through validateAndWrite", () => {
    fenceHeld("SCHM-026");
    expect(stdout).toContain("validateAndWrite seam fence: OK");
  });

  // @spec SCHM-027 unit
  test("SCHM-027: the write seam and the id allocator are reached only under operations/", () => {
    fenceHeld("SCHM-027");
  });

  // @spec SCHM-028 unit
  test("SCHM-028: the DDL declares no CHECK, FOREIGN KEY, or UNIQUE constraint on a domain field", () => {
    fenceHeld("SCHM-028");
  });

  // @spec SCHM-029 unit
  test("SCHM-029: the DDL is inline TypeScript, never a .sql file", () => {
    fenceHeld("SCHM-029");
  });

  // @spec PROV-004 unit
  test("PROV-004: issue_id is never a key, index, join, or grouping column", () => {
    fenceHeld("PROV-004");
    expect(stdout).toContain("issue_id-opacity gate: OK");
  });

  // @spec DIST-012 unit
  test("DIST-012: the README names spec init and NO_SPEC_CONFIG", () => {
    fenceHeld("DIST-012");
  });

  // @spec DIST-013 unit
  test("DIST-013: the README and AGENTS.md name SPEC.json, spec migrate, trusted-red, and --results", () => {
    fenceHeld("DIST-013");
  });

  // @spec DIST-014 unit
  test("DIST-014: no spec-engine.config.example.json ships in the tree", () => {
    fenceHeld("DIST-014");
  });

  // @spec TRK-004 unit
  test("TRK-004: engine internals never import the tracker and carry no external host literal", () => {
    fenceHeld("TRK-004");
    expect(stdout).toContain("tracker import fence: OK");
  });

  // @spec TRK-005 unit
  test("TRK-005: the tracker package sends GraphQL queries only", () => {
    fenceHeld("TRK-005");
  });

  // @spec TRK-006 unit
  test("TRK-006: the tracker never logs the token", () => {
    fenceHeld("TRK-006");
  });

  // @spec INDX-013 unit
  test("INDX-013: no SPEC.md parse path exists in the engine", () => {
    fenceHeld("INDX-013");
  });

  // @spec AUTHOR-008 unit
  test("AUTHOR-008: the runner emits the llm-free engine fence OK marker", () => {
    fenceHeld("AUTHOR-008");
    expect(stdout).toContain("llm-free engine fence: OK");
  });

  // @spec CHCK-020 unit
  test("CHCK-020: the committed GLOSSARY.md equals the generated one", () => {
    fenceHeld("CHCK-020");
  });

  // @spec SCHM-020 unit
  test("SCHM-020: the authored-specVersion fence trips on a planted non-TERM specVersion", () => {
    // Mirror the fence's detector against a planted non-TERM envelope.
    const offender = '{ "key": "BILLING", "specVersion": 2, "updated": "x", "requirements": [] }';
    const proc = Bun.spawnSync(["grep", "-qE", '"specVersion"'], { stdin: Buffer.from(offender) });
    expect(proc.exitCode).toBe(0);
    // And the real tree is clean: the fence prints its OK marker.
    fenceHeld("SCHM-020");
    expect(stdout).toContain("authored-specVersion fence: OK");
  });

  // @spec CHCK-030 unit
  test("CHCK-030: the AGENTS.md diagnostic-code list equals the DiagnosticCode enum", () => {
    fenceHeld("CHCK-030");
  });

  // @spec CHRT-007 unit
  test("CHRT-007: the TAXONOMY charters equal the envelope scope fields", () => {
    fenceHeld("CHRT-007");
  });

  // @spec AUTHOR-011 unit
  test("AUTHOR-011: the process-marker ledger only falls", () => {
    fenceHeld("AUTHOR-011");
  });

  test("every run label begins with a requirement id", async () => {
    const script = await Bun.file(FENCE_SCRIPT).text();
    const labels = [...script.matchAll(/^run "([^"]+)"/gm)].map((m) => m[1] ?? "");
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label).toMatch(/^[A-Z][A-Z0-9]*-\d{3} /);
  });
});
