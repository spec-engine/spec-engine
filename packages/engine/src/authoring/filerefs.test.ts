// @spec REQ-073 unit

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPEC_TOKEN } from "../testing/specTag";
import { extractRefsFromText, resolveFileRef } from "./filerefs";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-filerefs-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("extractRefsFromText — @-ref grammar", () => {
  test("plain ref in prose extracts the relative path", () => {
    expect(extractRefsFromText("see @api/src/renew.ts for the seam")).toEqual(["api/src/renew.ts"]);
  });

  test("email addresses never match (@ preceded by non-whitespace)", () => {
    expect(extractRefsFromText("user@example.com")).toEqual([]);
  });

  test("version pins like spec-engine@1 never match", () => {
    expect(extractRefsFromText("spec-engine@1")).toEqual([]);
  });

  test("@spec tags never match (no slash in candidate)", () => {
    expect(extractRefsFromText(`${SPEC_TOKEN} BILLING-001`)).toEqual([]);
  });

  test("trailing sentence punctuation is stripped", () => {
    expect(extractRefsFromText("look at @api/src/renew.ts.")).toEqual(["api/src/renew.ts"]);
  });

  test("multiple refs on one line are all extracted in order", () => {
    expect(
      extractRefsFromText("wire @api/src/charge.ts to @mobile/src/pay.ts before shipping"),
    ).toEqual(["api/src/charge.ts", "mobile/src/pay.ts"]);
  });
});

describe("resolveFileRef — platform-root containment + existence", () => {
  test("existing file under platformDir resolves", () => {
    const platform = join(tmp, "platform");
    mkdirSync(join(platform, "api", "src"), { recursive: true });
    writeFileSync(join(platform, "api", "src", "renew.ts"), "// x\n");
    expect(resolveFileRef(platform, "api/src/renew.ts")).toBe(true);
  });

  test("missing path does not resolve", () => {
    const platform = join(tmp, "platform");
    mkdirSync(platform, { recursive: true });
    expect(resolveFileRef(platform, "api/src/missing.ts")).toBe(false);
  });

  test("traversal ref outside the platform root is broken EVEN IF the file exists", () => {
    const platform = join(tmp, "platform");
    mkdirSync(platform, { recursive: true });
    writeFileSync(join(tmp, "escape.ts"), "// outside\n");
    expect(resolveFileRef(platform, "../escape.ts")).toBe(false);
  });
});
