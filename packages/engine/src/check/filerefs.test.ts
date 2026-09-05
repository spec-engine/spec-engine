// packages/engine/src/check/filerefs.test.ts
//
// The BROKEN_FILE_REF check pass (check/filerefs.ts). An Active or Draft
// requirement's `livesIn` entries must resolve to files under the platform
// root; terminal-status entries are exempt, and free field text is never
// scanned.
//
// Verifies:
// @spec CHCK-026 unit
// @spec CHCK-027 unit
// @spec CHCK-028 unit

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokenFileRefDiagnostics } from "./filerefs";

let platformDir: string;

beforeEach(() => {
  platformDir = mkdtempSync(join(tmpdir(), "spec-filerefs-"));
});

afterEach(() => {
  rmSync(platformDir, { recursive: true, force: true });
});

/** Write one domain envelope plus any real files the fixture needs. */
function writePlatform(
  requirements: Array<Record<string, unknown>>,
  realFiles: string[] = [],
): void {
  mkdirSync(join(platformDir, "spec-engine", "BILLING"), { recursive: true });
  writeFileSync(
    join(platformDir, "spec-engine", "BILLING", "SPEC.json"),
    `${JSON.stringify(
      {
        key: "BILLING",
        owner: null,
        specVersion: 1,
        updated: "2026-08-16",
        requirements,
      },
      null,
      2,
    )}\n`,
  );
  for (const rel of realFiles) {
    const abs = join(platformDir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "// present\n");
  }
}

function req(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "BILLING-001",
    status: "active",
    statement: "The system shall charge a renewal.",
    why: "Revenue.",
    livesIn: [],
    issues: [],
    ...over,
  };
}

describe("BROKEN_FILE_REF", () => {
  test("an Active requirement's unresolvable livesIn entry reports at error severity", async () => {
    writePlatform([req({ livesIn: ["src/missing.ts"] })]);
    const rows = await brokenFileRefDiagnostics(platformDir);
    expect(rows.length).toBe(1);
    expect(rows[0].code).toBe("BROKEN_FILE_REF");
    expect(rows[0].severity).toBe("error");
    expect(rows[0].req_id).toBe("BILLING-001");
    expect(rows[0].source_file).toBe("spec-engine/BILLING/SPEC.json");
    expect(rows[0].detail).toContain("src/missing.ts");
  });

  test("a resolvable livesIn entry reports nothing, with or without the @ prefix", async () => {
    writePlatform(
      [
        req({ id: "BILLING-001", livesIn: ["src/renew.ts"] }),
        req({ id: "BILLING-002", livesIn: ["@src/renew.ts"] }),
      ],
      ["src/renew.ts"],
    );
    expect(await brokenFileRefDiagnostics(platformDir)).toEqual([]);
  });

  test("a traversal ref is broken even when the target exists outside the root", async () => {
    writePlatform([req({ livesIn: ["../escape.ts"] })]);
    writeFileSync(join(platformDir, "..", "escape.ts"), "// outside\n");
    const rows = await brokenFileRefDiagnostics(platformDir);
    expect(rows.length).toBe(1);
    expect(rows[0].req_id).toBe("BILLING-001");
    rmSync(join(platformDir, "..", "escape.ts"), { force: true });
  });

  // @spec CHCK-027
  test("superseded and deprecated entries are exempt", async () => {
    writePlatform([
      req({ id: "BILLING-001", status: "superseded", livesIn: ["src/gone.ts"] }),
      req({ id: "BILLING-002", status: "deprecated", livesIn: ["src/gone.ts"] }),
      req({ id: "BILLING-003", status: "draft", livesIn: ["src/gone.ts"] }),
    ]);
    const rows = await brokenFileRefDiagnostics(platformDir);
    // Only the Draft entry is judged.
    expect(rows.map((r) => r.req_id)).toEqual(["BILLING-003"]);
  });

  // @spec CHCK-028
  test("a scoped npm package name in statement or why text is never reported", async () => {
    writePlatform([
      req({
        statement:
          "The published @spec-engine/spec-engine tarball shall contain only the built dist payload.",
        why: "Mentioning @some-scope/pkg is not a file reference.",
        livesIn: [],
      }),
    ]);
    expect(await brokenFileRefDiagnostics(platformDir)).toEqual([]);
  });

  test("rows are sorted and byte-stable across runs", async () => {
    writePlatform([
      req({ id: "BILLING-003", livesIn: ["c.ts"] }),
      req({ id: "BILLING-001", livesIn: ["a.ts", "b.ts"] }),
    ]);
    const first = await brokenFileRefDiagnostics(platformDir);
    const second = await brokenFileRefDiagnostics(platformDir);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.length).toBe(3);
    // Sorted by line, so the first requirement in the file leads.
    expect(first[0].req_id).toBe("BILLING-003");
  });
});
