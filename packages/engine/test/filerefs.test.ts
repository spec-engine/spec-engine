// packages/engine/test/filerefs.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec REQ-012 unit
//
// Quick task 260605-tqz / Task 1 (D-03): @file-ref substrate.
//
// Q4 (Phase 18): the index-time raw-walk field extractor and its
// broken-file-ref emission are RETIRED with the Markdown parse path. Only the
// authoring-time surface survives, so this file covers exactly two layers:
//   1. extractRefsFromText — the @<relative/path> grammar over one plain
//      string: at-least-one-slash rule excludes emails, `spec-engine@1`
//      version pins, and `@spec` tags; trailing sentence punctuation is
//      stripped; multiple refs per line all extracted.
//   2. resolveFileRef — containment FIRST (AUTHC-006 posture): a traversal
//      ref resolving outside the platform root is broken EVEN IF the target
//      file exists; then existsSync.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRefsFromText, resolveFileRef } from "../src/authoring/filerefs";
import { SPEC_TOKEN } from "./fixtures/specTag";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-filerefs-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. extractRefsFromText — grammar (AUTHC-023)
// ---------------------------------------------------------------------------

describe("extractRefsFromText — @-ref grammar (AUTHC-023)", () => {
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

// ---------------------------------------------------------------------------
// 2. resolveFileRef — containment FIRST, then existence
// ---------------------------------------------------------------------------

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
    // The escape target EXISTS — containment must dominate existence.
    writeFileSync(join(tmp, "escape.ts"), "// outside\n");
    expect(resolveFileRef(platform, "../escape.ts")).toBe(false);
  });
});
