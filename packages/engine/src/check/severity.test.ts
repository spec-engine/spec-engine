import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Diagnostic, SeverityRule } from "@spec-engine/shared";
import { applySeverity, readCheckConfig } from "./severity";

function row(code: Diagnostic["code"], req_id: string | null): Diagnostic {
  return { code, req_id, severity: "error", repo: null, source_file: null, line: null, detail: "" };
}

describe("applySeverity", () => {
  // @spec CHCK-036 unit
  test("an unscoped rule grades every row of its code and no other", () => {
    const rules: SeverityRule[] = [{ code: "ORPHAN_REQ", severity: "warning" }];
    const out = applySeverity([row("ORPHAN_REQ", "A-001"), row("DRIFT", "A-001")], rules);
    expect(out.map((d) => [d.code, d.severity])).toEqual([
      ["ORPHAN_REQ", "warning"],
      ["DRIFT", "error"],
    ]);
  });

  // @spec CHCK-037 unit
  test("an id match beats a domain match, which beats an unscoped rule, in any order", () => {
    const rules: SeverityRule[] = [
      { code: "UNVERIFIED_REQ", severity: "error", match: ["BILLING-002"] },
      { code: "UNVERIFIED_REQ", severity: "warning", match: ["BILLING"] },
      { code: "UNVERIFIED_REQ", severity: "error" },
    ];
    const out = applySeverity(
      [
        row("UNVERIFIED_REQ", "BILLING-001"),
        row("UNVERIFIED_REQ", "BILLING-002"),
        row("UNVERIFIED_REQ", "AUTH-001"),
        row("UNVERIFIED_REQ", null),
      ],
      rules,
    );
    expect(out.map((d) => [d.req_id, d.severity])).toEqual([
      ["BILLING-001", "warning"],
      ["BILLING-002", "error"],
      ["AUTH-001", "error"],
      [null, "error"],
    ]);
  });

  // @spec CHCK-037 unit
  test("a scoped rule leaves rows outside its match list untouched", () => {
    const rules: SeverityRule[] = [{ code: "ORPHAN_REQ", severity: "warning", match: ["AUTH"] }];
    const out = applySeverity([row("ORPHAN_REQ", "AUTHX-001"), row("ORPHAN_REQ", null)], rules);
    expect(out.map((d) => d.severity)).toEqual(["error", "error"]);
  });

  // @spec CHCK-038 unit
  test("off drops the row", () => {
    const rules: SeverityRule[] = [
      { code: "ORPHAN_REQ", severity: "off", match: ["A"] },
      { code: "DRIFT", severity: "off" },
    ];
    const out = applySeverity(
      [row("ORPHAN_REQ", "A-001"), row("ORPHAN_REQ", "B-001"), row("DRIFT", "A-001")],
      rules,
    );
    expect(out.map((d) => [d.code, d.req_id])).toEqual([["ORPHAN_REQ", "B-001"]]);
  });
});

describe("readCheckConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spec-check-config-"));
    mkdirSync(join(dir, "spec-engine"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (body: string) => writeFileSync(join(dir, "spec-engine", "check.json"), body);

  test("an absent file is no rules", () => {
    expect(readCheckConfig(dir)).toEqual({ ok: true, config: { severity: [] } });
  });

  // @spec CHCK-039 unit
  test("a schema failure names the file and the failing path", () => {
    write(JSON.stringify({ severity: [{ code: "ORPHAN_REQ", severity: "loud" }] }));
    const r = readCheckConfig(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toStartWith("spec-engine/check.json: severity.0.severity:");
  });

  // @spec CHCK-039 unit
  test("an unknown code, an unknown key, and a bad match entry each fail", () => {
    for (const rule of [
      { code: "NOPE", severity: "off" },
      { code: "DRIFT", severity: "off", extra: 1 },
      { code: "DRIFT", severity: "off", match: ["billing"] },
    ]) {
      write(JSON.stringify({ severity: [rule] }));
      expect(readCheckConfig(dir).ok).toBe(false);
    }
  });
});
