// @spec CHCK-045 unit
// @spec CHCK-027 unit
// @spec CHCK-028 unit

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic } from "@spec-engine/shared";
import { withIndex } from "../operations/_index";
import { check } from "../operations/check";
import { type DomainHandle, TestPlatform } from "../testing/platform";
import { specTag } from "../testing/specTag";
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

  test("every livesIn entry is checked, not only the first", async () => {
    await billing.req({
      statement: STATEMENT,
      livesIn: ["src/renew.ts", "src/missing-a.ts", "src/missing-b.ts"],
    });
    fx.file("src/renew.ts", "// present\n");
    const details = (await brokenFileRefDiagnostics(platformDir)).map((r) => r.detail);
    expect(details).toHaveLength(2);
    expect(details.join("\n")).toContain("src/missing-a.ts");
    expect(details.join("\n")).toContain("src/missing-b.ts");
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

describe("BROKEN_FILE_REF on verifiedIn", () => {
  test("an Active or Draft requirement's unresolvable verifiedIn entry reports at error severity", async () => {
    await billing.req({ statement: STATEMENT, verifiedIn: ["test/missing.test.ts"] });
    await billing.req({ statement: STATEMENT, status: "draft", verifiedIn: ["test/gone.test.ts"] });
    const rows = await brokenFileRefDiagnostics(platformDir);
    expect(rows.map((r) => [r.req_id, r.severity])).toEqual([
      ["BILLING-001", "error"],
      ["BILLING-002", "error"],
    ]);
    expect(rows[0]?.detail).toBe(
      "verifiedIn entry test/missing.test.ts does not resolve to a file under the platform root",
    );
  });

  test("a resolvable verifiedIn entry and a superseded entry's broken one report nothing", async () => {
    fx.file("test/renew.test.ts", "// present\n");
    await billing.req({ statement: STATEMENT, verifiedIn: ["test/renew.test.ts"] });
    const old = await billing.req({ statement: STATEMENT, verifiedIn: ["test/gone.test.ts"] });
    await billing.supersede(old.id, { statement: STATEMENT, verifiedIn: [] });
    expect(await brokenFileRefDiagnostics(platformDir)).toEqual([]);
  });
});

async function inFileRows(): Promise<{ rows: Diagnostic[]; failing: boolean }> {
  const result = await withIndex({ platformDir, build: "fresh" }, (h) =>
    check({ platformDir }, h.storage),
  );
  if (!result.ok) throw new Error(result.detail);
  const rows = result.diagnostics.filter(
    (d) => d.code === "UNIMPLEMENTED_IN_FILE" || d.code === "UNVERIFIED_IN_FILE",
  );
  return { rows, failing: result.failing };
}

describe("UNIMPLEMENTED_IN_FILE and UNVERIFIED_IN_FILE", () => {
  // @spec CHCK-046 unit
  // @spec CHCK-047 unit
  test("tagged livesIn and verifiedIn files report nothing", async () => {
    const id = await billing.nextId();
    await fx.member("api", {
      files: {
        "src/renew.ts": `export const renew = 1;\n${specTag(id)}`,
        "src/renew.test.ts": `${specTag(id, "unit")}`,
      },
    });
    await billing.req({
      statement: STATEMENT,
      livesIn: ["api/src/renew.ts"],
      verifiedIn: ["api/src/renew.test.ts"],
    });
    expect((await inFileRows()).rows).toEqual([]);
  });

  // @spec CHCK-046 unit
  // @spec CHCK-047 unit
  test("an untagged scannable file reports one warning per list", async () => {
    const id = await billing.nextId();
    await fx.member("api", {
      files: {
        "src/other.ts": `export const other = 1;\n${specTag(id)}`,
        "src/renew.ts": "export const renew = 1;\n",
        "src/renew.test.ts": "export {};\n",
      },
    });
    await billing.req({
      statement: STATEMENT,
      livesIn: ["api/src/renew.ts"],
      verifiedIn: ["api/src/renew.test.ts"],
    });
    const { rows, failing } = await inFileRows();
    expect(rows).toEqual([
      {
        code: "UNIMPLEMENTED_IN_FILE",
        severity: "warning",
        repo: null,
        source_file: "spec-engine/BILLING/SPEC.json",
        line: rows[0]?.line ?? -1,
        req_id: id,
        detail: `livesIn entry api/src/renew.ts holds no implementing or documenting tag for ${id}`,
      },
      {
        code: "UNVERIFIED_IN_FILE",
        severity: "warning",
        repo: null,
        source_file: "spec-engine/BILLING/SPEC.json",
        line: rows[0]?.line ?? -1,
        req_id: id,
        detail: `verifiedIn entry api/src/renew.test.ts holds no verifying tag for ${id}`,
      },
    ]);
    expect(rows[0]?.line).toBeGreaterThan(0);
    expect(failing).toBe(false);
  });

  // @spec CHCK-047 unit
  test("an implementing tag does not satisfy verifiedIn", async () => {
    const id = await billing.nextId();
    await fx.member("api", { files: { "src/renew.ts": specTag(id) } });
    await billing.req({ statement: STATEMENT, verifiedIn: ["api/src/renew.ts"] });
    expect((await inFileRows()).rows.map((r) => r.code)).toEqual(["UNVERIFIED_IN_FILE"]);
  });

  // @spec CHCK-046 unit
  test("a documenting tag satisfies livesIn", async () => {
    const id = await billing.nextId();
    await fx.member("api", {
      files: {
        "src/renew.ts": specTag(id),
        "docs/renew.md": `Renewal charging. <!-- ${"@spec"} ${id} -->\n`,
      },
    });
    await billing.req({ statement: STATEMENT, livesIn: ["api/docs/renew.md"] });
    expect((await inFileRows()).rows).toEqual([]);
  });

  // @spec CHCK-046 unit
  // @spec CHCK-047 unit
  test("a JSON file, a dot-directory file, and an ignored file report nothing", async () => {
    const id = await billing.nextId();
    await fx.member("api", {
      files: {
        "src/renew.ts": specTag(id),
        ".claude/hook.ts": "export {};\n",
        "vendor/lib.ts": "export {};\n",
      },
      ignore: ["vendor"],
    });
    await billing.req({
      statement: STATEMENT,
      livesIn: ["api/spec-engine.member.json", "api/.claude/hook.ts", "api/vendor/lib.ts"],
      verifiedIn: ["api/spec-engine.member.json", "api/.claude/hook.ts"],
    });
    expect((await inFileRows()).rows).toEqual([]);
  });

  // @spec CHCK-046 unit
  test("a lone repository maps its platform-relative path onto its column", async () => {
    const id = await billing.nextId();
    fx.file("src/renew.ts", specTag(id));
    fx.file("src/price.ts", "export const price = 1;\n");
    await billing.req({ statement: STATEMENT, livesIn: ["src/renew.ts", "src/price.ts"] });
    const { rows } = await inFileRows();
    expect(rows.map((r) => r.detail)).toEqual([
      `livesIn entry src/price.ts holds no implementing or documenting tag for ${id}`,
    ]);
  });

  // @spec CHCK-046 unit
  // @spec CHCK-047 unit
  test("Draft, superseded, and deprecated entries report nothing", async () => {
    await fx.member("api", { files: { "src/renew.ts": "export {};\n" } });
    const lists = { livesIn: ["api/src/renew.ts"], verifiedIn: ["api/src/renew.ts"] };
    await billing.req({ statement: STATEMENT, status: "draft", ...lists });
    const old = await billing.req({ statement: STATEMENT, ...lists });
    await billing.supersede(old.id, { statement: STATEMENT, livesIn: [], verifiedIn: [] });
    const gone = await billing.req({ statement: STATEMENT, ...lists });
    await billing.deprecate(gone.id);
    expect((await inFileRows()).rows).toEqual([]);
  });

  // @spec CHCK-046 unit
  test("check.json regrading UNIMPLEMENTED_IN_FILE to error fails the check", async () => {
    const id = await billing.nextId();
    await fx.member("api", {
      files: { "src/renew.ts": "export {};\n", "src/renew.test.ts": specTag(id, "unit") },
    });
    await fx.member("web", { files: { "src/renew.ts": specTag(id) } });
    await billing.req({ statement: STATEMENT, livesIn: ["api/src/renew.ts"] });
    expect(await inFileRows()).toEqual({
      rows: [expect.objectContaining({ code: "UNIMPLEMENTED_IN_FILE", severity: "warning" })],
      failing: false,
    });
    fx.file(
      "spec-engine/check.json",
      JSON.stringify({ severity: [{ code: "UNIMPLEMENTED_IN_FILE", severity: "error" }] }),
    );
    expect(await inFileRows()).toEqual({
      rows: [expect.objectContaining({ code: "UNIMPLEMENTED_IN_FILE", severity: "error" })],
      failing: true,
    });
  });
});
