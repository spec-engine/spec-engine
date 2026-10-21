import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProvenanceMatrixRow } from "@spec-engine/shared";
import type { TrackerAdapter, TrackerResult } from "@spec-engine/tracker";
import { sidecarPath, writeCache } from "@spec-engine/tracker";
import { resolveAndCache } from "./resolve";

/** An adapter that records exactly which ids it was asked to resolve, so tests
 *  can assert the cache spared the network for fresh entries + deduped. */
function recordingAdapter(seen: string[][], reply: (id: string) => TrackerResult): TrackerAdapter {
  return {
    name: "recording",
    matches: () => true,
    async resolveIssues(ids) {
      const asked = [...ids];
      seen.push(asked);
      const out = new Map<string, TrackerResult>();
      for (const id of asked) out.set(id, reply(id));
      return out;
    },
  };
}

const NOW = 1_700_000_000_000; // fixed epoch ms so freshness is deterministic

function prov(issue_id: string): ProvenanceMatrixRow {
  return {
    req_id: "BILLING-9",
    role: "created",
    issue_id,
    source_file: "spec-engine/BILLING/SPEC.md",
    line: 1,
    req_status: "Active",
    implemented: 1,
    verified: 1,
    test_levels: "unit",
  };
}

let tmp: string;
let savedToken: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-resolve-"));
  savedToken = process.env.SPEC_TRACKER_TOKEN;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedToken === undefined) delete process.env.SPEC_TRACKER_TOKEN;
  else process.env.SPEC_TRACKER_TOKEN = savedToken;
});

/** A stub adapter returning one ok:true and one ok:false result. */
function stubAdapter(): TrackerAdapter {
  return {
    name: "stub",
    matches: () => true,
    async resolveIssues(ids) {
      const out = new Map<string, TrackerResult>();
      for (const id of ids) {
        if (id === "ENG-1") {
          out.set(id, {
            ok: true,
            id,
            value: { title: "Renew charge", status: "Done", url: "https://linear.app/x" },
          });
        } else {
          out.set(id, { ok: false, id, reason: "unauthorized" });
        }
      }
      return out;
    },
  };
}

describe("resolveAndCache", () => {
  test("maps TrackerResult → ResolvedShape and caches only the ok:true hit", async () => {
    const rows = [prov("ENG-1"), prov("ENG-2")];
    const map = await resolveAndCache(rows, tmp, stubAdapter());

    expect(map.get("ENG-1")).toEqual({
      ok: true,
      title: "Renew charge",
      status: "Done",
      url: "https://linear.app/x",
      stale: false,
    });
    // ok:false carries NO reason — absent and failed collapse downstream.
    expect(map.get("ENG-2")).toEqual({ ok: false });

    const cache = (await Bun.file(sidecarPath(tmp)).json()) as Record<string, unknown>;
    expect(Object.keys(cache)).toEqual(["ENG-1"]);
    expect(cache["ENG-1"]).toMatchObject({
      title: "Renew charge",
      status: "Done",
      url: "https://linear.app/x",
    });
  });

  test("no token → every id degrades to {ok:false}, never throws (default adapter)", async () => {
    delete process.env.SPEC_TRACKER_TOKEN;
    const rows = [prov("ENG-1432"), prov("ENG-1781")];
    const map = await resolveAndCache(rows, tmp);
    expect(map.get("ENG-1432")).toEqual({ ok: false });
    expect(map.get("ENG-1781")).toEqual({ ok: false });
  });

  test("a FRESH cached entry is served without asking the adapter", async () => {
    await writeCache(tmp, {
      "ENG-1": {
        title: "Cached title",
        status: "In Progress",
        url: "https://linear.app/cached",
        fetched_at: new Date(NOW - 1000).toISOString(), // 1s old → fresh
      },
    });
    const seen: string[][] = [];
    const map = await resolveAndCache(
      [prov("ENG-1")],
      tmp,
      recordingAdapter(seen, () => {
        throw new Error("adapter must not be called for a fresh entry");
      }),
      NOW,
    );

    expect(map.get("ENG-1")).toEqual({
      ok: true,
      title: "Cached title",
      status: "In Progress",
      stale: false,
      url: "https://linear.app/cached",
    });
    expect(seen).toEqual([]);
  });

  // @spec PROV-002 unit
  test("a STALE entry whose re-resolve fails is served STALE (not degraded)", async () => {
    await writeCache(tmp, {
      "ENG-1": {
        title: "Old title",
        status: "Done",
        url: "https://linear.app/old",
        fetched_at: new Date(NOW - 48 * 60 * 60 * 1000).toISOString(), // 48h old → stale
      },
    });
    const seen: string[][] = [];
    const map = await resolveAndCache(
      [prov("ENG-1")],
      tmp,
      recordingAdapter(seen, (id) => ({ ok: false, id, reason: "offline" })),
      NOW,
    );

    expect(seen).toEqual([["ENG-1"]]);
    expect(map.get("ENG-1")).toEqual({
      ok: true,
      title: "Old title",
      status: "Done",
      url: "https://linear.app/old",
      stale: true,
    });
  });

  test("duplicate ids are resolved once", async () => {
    const seen: string[][] = [];
    const rows = [prov("ENG-1"), prov("ENG-1"), prov("ENG-2")];
    await resolveAndCache(
      rows,
      tmp,
      recordingAdapter(seen, (id) => ({ ok: false, id, reason: "not_found" })),
      NOW,
    );
    expect(seen).toEqual([["ENG-1", "ENG-2"]]);
  });
});
