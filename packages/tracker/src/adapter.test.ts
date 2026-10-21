// The id mix (ENG-, BILLING-, KEY-NNN) proves opacity: ids are returned
// verbatim, never parsed for identity or routing.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { noopAdapter } from "./adapter";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("noopAdapter — offline-first default", () => {
  test("matches() is true for every id shape (no-op claims all)", () => {
    expect(noopAdapter.matches("ENG-7")).toBe(true);
    expect(noopAdapter.matches("FOO-1")).toBe(true);
    expect(noopAdapter.matches("BILLING-009")).toBe(true);
    expect(noopAdapter.matches("KEY-001")).toBe(true);
    expect(noopAdapter.matches("")).toBe(true);
  });

  test("conforms to TrackerAdapter (name 'noop', matches, resolveIssues)", () => {
    expect(noopAdapter.name).toBe("noop");
    expect(typeof noopAdapter.matches).toBe("function");
    expect(typeof noopAdapter.resolveIssues).toBe("function");
  });

  test("resolveIssues degrades every id to its bare opaque id (absent)", async () => {
    const ids = ["ENG-1", "BILLING-009", "KEY-001"];
    const out = await noopAdapter.resolveIssues(ids);

    expect(out.size).toBe(ids.length);
    for (const id of ids) {
      const result = out.get(id);
      expect(result).toEqual({ ok: false, id, reason: "absent" });
    }
  });

  test("offline path makes NO network call (fetch spy not invoked)", async () => {
    const fetchSpy = mock(() => {
      throw new Error("network called!");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      noopAdapter.resolveIssues(["ENG-1", "BILLING-009", "KEY-001"]),
    ).resolves.toBeInstanceOf(Map);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
