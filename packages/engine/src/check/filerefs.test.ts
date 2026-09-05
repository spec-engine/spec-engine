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
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DomainHandle, TestPlatform } from "../testing/platform";
import { brokenFileRefDiagnostics } from "./filerefs";

let fx: TestPlatform;
let platformDir: string;
let billing: DomainHandle;

beforeEach(async () => {
  fx = TestPlatform.temp("spec-filerefs-");
  platformDir = fx.dir;
  billing = await fx.domain("BILLING");
});

afterEach(() => {
  fx.remove();
});

const STATEMENT = "The system shall charge a renewal.";

describe("BROKEN_FILE_REF", () => {
  test("an Active requirement's unresolvable livesIn entry reports at error severity", async () => {
    await billing.req({ statement: STATEMENT, why: "Revenue.", livesIn: ["src/missing.ts"] });
    const rows = await brokenFileRefDiagnostics(platformDir);
    expect(rows.length).toBe(1);
    expect(rows[0]?.code).toBe("BROKEN_FILE_REF");
    expect(rows[0]?.severity).toBe("error");
    expect(rows[0]?.req_id).toBe("BILLING-001");
    expect(rows[0]?.source_file).toBe("spec-engine/BILLING/SPEC.json");
    expect(rows[0]?.detail).toContain("src/missing.ts");
  });

  test("a resolvable livesIn entry reports nothing, with or without the @ prefix", async () => {
    await billing.req({ statement: STATEMENT, livesIn: ["src/renew.ts"] });
    await billing.req({ statement: STATEMENT, livesIn: ["@src/renew.ts"] });
    fx.file("src/renew.ts", "// present\n");
    expect(await brokenFileRefDiagnostics(platformDir)).toEqual([]);
  });

  test("a traversal ref is broken even when the target exists outside the root", async () => {
    await billing.req({ statement: STATEMENT, livesIn: ["../escape.ts"] });
    writeFileSync(join(platformDir, "..", "escape.ts"), "// outside\n");
    const rows = await brokenFileRefDiagnostics(platformDir);
    expect(rows.length).toBe(1);
    expect(rows[0]?.req_id).toBe("BILLING-001");
    rmSync(join(platformDir, "..", "escape.ts"), { force: true });
  });

  // @spec CHCK-027
  test("superseded and deprecated entries are exempt", async () => {
    const superseded = await billing.req({ statement: STATEMENT, livesIn: ["src/gone.ts"] });
    await billing.supersede(superseded.id, { statement: STATEMENT, livesIn: [] });
    const deprecated = await billing.req({ statement: STATEMENT, livesIn: ["src/gone.ts"] });
    await billing.deprecate(deprecated.id);
    const draft = await billing.req({
      statement: STATEMENT,
      status: "draft",
      livesIn: ["src/gone.ts"],
    });
    const rows = await brokenFileRefDiagnostics(platformDir);
    // Only the Draft entry is judged.
    expect(rows.map((r) => r.req_id)).toEqual([draft.id]);
  });

  // @spec CHCK-028
  test("a scoped npm package name in statement or why text is never reported", async () => {
    await billing.req({
      statement:
        "The published @spec-engine/spec-engine tarball shall contain only the built dist payload.",
      why: "Mentioning @some-scope/pkg is not a file reference.",
    });
    expect(await brokenFileRefDiagnostics(platformDir)).toEqual([]);
  });

  test("rows are sorted and byte-stable across runs", async () => {
    await billing.req({ statement: STATEMENT, livesIn: ["c.ts"] });
    await billing.req({ statement: STATEMENT, livesIn: ["a.ts", "b.ts"] });
    const first = await brokenFileRefDiagnostics(platformDir);
    const second = await brokenFileRefDiagnostics(platformDir);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.length).toBe(3);
    // Sorted by line, so the first requirement in the file leads.
    expect(first[0]?.req_id).toBe("BILLING-001");
  });
});
