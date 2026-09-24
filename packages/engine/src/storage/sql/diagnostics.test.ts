// packages/engine/src/storage/sql/diagnostics.test.ts
//
// @spec CHCK-032 unit

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { withIndex } from "../../operations/_index";
import { check } from "../../operations/check";
import { TestPlatform } from "../../testing/platform";
import { specTag } from "../../testing/specTag";

let fx: TestPlatform;

beforeEach(() => {
  fx = TestPlatform.temp("spec-draft-diagnostics-");
});

afterEach(() => {
  fx.remove();
});

async function codesFor(id: string): Promise<string[]> {
  const result = await withIndex({ platformDir: fx.dir, build: "fresh" }, (h) =>
    check({ platformDir: fx.dir }, h.storage),
  );
  if (!result.ok) throw new Error(result.detail);
  return result.diagnostics.filter((d) => d.req_id === id).map((d) => d.code);
}

describe("ORPHAN_REQ and UNVERIFIED_REQ", () => {
  test("an untagged Draft is not an orphan; the same Active entry is", async () => {
    const billing = await fx.domain("BILLING");
    const draft = await billing.req({ statement: "s", why: "w", status: "draft" });
    const active = await billing.req({ statement: "s", why: "w" });

    expect(await codesFor(draft.id)).not.toContain("ORPHAN_REQ");
    expect(await codesFor(active.id)).toContain("ORPHAN_REQ");
  });

  test("an implemented but unverified Draft is not unverified; the same Active entry is", async () => {
    const billing = await fx.domain("BILLING");
    const draft = await billing.req({ statement: "s", why: "w", status: "draft" });
    const active = await billing.req({ statement: "s", why: "w" });
    await fx.member("api", {
      files: { "src/x.ts": `export const x = 1; ${specTag(draft.id)}${specTag(active.id)}` },
    });

    expect(await codesFor(draft.id)).not.toContain("UNVERIFIED_REQ");
    expect(await codesFor(active.id)).toContain("UNVERIFIED_REQ");
  });
});
