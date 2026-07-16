// packages/engine/test/provenance-decorate.test.ts
//
// Phase 16 Plan 01 (PWEB-02 / PWEB-03): the ONE shared decorator that both the
// CLI (this plan) and the webapp (Plan 02) render through, so the two surfaces
// cannot drift (one engine, not two). Pure formatter test — ProvenanceMatrixRow
// + a plain ResolvedShape map in, string/JSON out. No I/O, no Storage, no
// @spec-engine/tracker, no bun:sqlite (D-08 + the engine-internal import fence).
//
// Contract under test:
//   - decorateRow(row, {ok:true, title, status, url}) overlays title/status/url
//     on the row's link line — NOT the bare-id hint.
//   - decorateRow(row, {ok:false}) for an ABSENT-style result is BYTE-IDENTICAL
//     to decorateRow(row, {ok:false}) for a FAILED-style result — the decorator
//     never sees `reason`, so absent and failed are structurally indistinguishable
//     (PWEB-03 / Pitfall 3). Both render the bare issue_id + "set SPEC_TRACKER_TOKEN".
//   - decorateRow(row, undefined) (id missing from the map) === the ok:false render.
//   - renderProvenanceDecorated(rows, map, "json") emits a deterministic array
//     sorted by the SAME composite key as sortProvenance, each row carrying a
//     `resolved` field ({title,status,url} on hit, null on miss).
//   - renderProvenance default path is unchanged (no signature/format drift).

import { describe, expect, test } from "bun:test";
import type { ProvenanceMatrixRow } from "@spec-engine/shared";
import {
  decorateRow,
  type ResolvedShape,
  renderProvenance,
  renderProvenanceDecorated,
} from "../src/provenance/format";

/** ProvenanceMatrixRow factory — mirrors provenance-format.test.ts. */
function prov(
  req_id: string,
  role: string,
  issue_id: string,
  opts: Partial<ProvenanceMatrixRow> = {},
): ProvenanceMatrixRow {
  return {
    req_id,
    role,
    issue_id,
    source_file: opts.source_file ?? "spec-engine/BILLING/SPEC.md",
    line: opts.line ?? 1,
    req_status: opts.req_status ?? "Active",
    implemented: opts.implemented ?? 1,
    verified: opts.verified ?? 1,
    test_levels: opts.test_levels ?? "unit,integration",
  };
}

describe("decorateRow", () => {
  test("ok:true overlays title/status/url and NOT the bare-id hint", () => {
    const row = prov("BILLING-9", "created", "ENG-1432");
    const resolved: ResolvedShape = {
      ok: true,
      title: "Renew charge",
      status: "Done",
      url: "https://linear.app/x",
    };
    const line = decorateRow(row, resolved);
    expect(line).toContain("Renew charge");
    expect(line).toContain("Done");
    expect(line).toContain("https://linear.app/x");
    expect(line).not.toContain("set SPEC_TRACKER_TOKEN");
  });

  test("ok:false ABSENT === ok:false FAILED — byte-identical bare-ID + hint (Pitfall 3)", () => {
    const row = prov("BILLING-9", "created", "ENG-1432");
    // The decorator receives no `reason` on either path — absent (noop) and
    // failed (unauthorized/offline/...) both collapse to {ok:false}.
    const absent: ResolvedShape = { ok: false };
    const failed: ResolvedShape = { ok: false };
    const absentLine = decorateRow(row, absent);
    const failedLine = decorateRow(row, failed);
    expect(absentLine).toBe(failedLine);
    expect(absentLine).toContain("ENG-1432");
    expect(absentLine).toContain("set SPEC_TRACKER_TOKEN");
    expect(absentLine).not.toContain("https://");
  });

  test("undefined resolution renders the SAME bare-ID + hint as ok:false", () => {
    const row = prov("BILLING-9", "created", "ENG-1432");
    expect(decorateRow(row, undefined)).toBe(decorateRow(row, { ok: false }));
  });

  test("WR-02: ok:true with empty/missing fields DEGRADES cleanly (no malformed line)", () => {
    const row = prov("BILLING-9", "created", "ENG-1432");
    const degraded = decorateRow(row, { ok: false });
    // An ok:true result whose required fields are empty/missing must fall back to
    // the bare-ID + hint render — NEVER emit a malformed `… [] ` overlay.
    const emptyTitle: ResolvedShape = { ok: true, title: "", status: "Done", url: "https://x" };
    const emptyUrl: ResolvedShape = { ok: true, title: "Renew", status: "Done", url: "" };
    const missingFields: ResolvedShape = { ok: true };
    for (const shape of [emptyTitle, emptyUrl, missingFields]) {
      const line = decorateRow(row, shape);
      expect(line).toBe(degraded);
      expect(line).toContain("set SPEC_TRACKER_TOKEN");
      // No dangling empty bracket / trailing-space overlay.
      expect(line).not.toContain("[]");
    }
  });
});

describe("renderProvenanceDecorated", () => {
  test("json mode: deterministic sort + per-row resolved field (hit vs miss)", () => {
    const rows = [
      prov("BILLING-10", "created", "ENG-100"),
      prov("BILLING-9", "created", "ENG-1432"),
    ];
    const map = new Map<string, ResolvedShape>([
      [
        "ENG-1432",
        { ok: true, title: "Renew charge", status: "Done", url: "https://linear.app/x" },
      ],
      ["ENG-100", { ok: false }],
    ]);
    const json = renderProvenanceDecorated(rows, map, "json");
    const parsed = JSON.parse(json) as Array<ProvenanceMatrixRow & { resolved: unknown }>;
    // Sorted by the same composite key: BILLING-9 (seq 9) before BILLING-10.
    expect(parsed.map((r) => r.req_id)).toEqual(["BILLING-9", "BILLING-10"]);
    // Hit carries {title,status,url}; miss carries null.
    expect(parsed[0]?.resolved).toEqual({
      title: "Renew charge",
      status: "Done",
      url: "https://linear.app/x",
    });
    expect(parsed[1]?.resolved).toBeNull();
    // Deterministic: same input → same bytes.
    expect(renderProvenanceDecorated(rows, map, "json")).toBe(json);
  });

  test("text mode: ok:true overlays metadata; ok:false renders bare-ID + hint", () => {
    const rows = [
      prov("BILLING-9", "created", "ENG-1432"),
      prov("BILLING-9", "amends-via", "ENG-7"),
    ];
    const map = new Map<string, ResolvedShape>([
      [
        "ENG-1432",
        { ok: true, title: "Renew charge", status: "Done", url: "https://linear.app/x" },
      ],
      // ENG-7 absent from the map → degraded.
    ]);
    const text = renderProvenanceDecorated(rows, map, "text");
    expect(text).toContain("Renew charge");
    expect(text).toContain("ENG-7");
    expect(text).toContain("set SPEC_TRACKER_TOKEN");
    // The requirement header is still rendered.
    expect(text).toContain("BILLING-9");
  });

  test("empty input → '[]' (json) / '' (text)", () => {
    const empty = new Map<string, ResolvedShape>();
    expect(renderProvenanceDecorated([], empty, "json")).toBe("[]");
    expect(renderProvenanceDecorated([], empty, "text")).toBe("");
  });

  test("WR-01: json arm's degraded marker for an ok:false id is a stable `resolved: null` (NOT the text hint)", () => {
    const rows = [prov("BILLING-9", "created", "ENG-1432")];
    const map = new Map<string, ResolvedShape>([["ENG-1432", { ok: false }]]);
    const json = renderProvenanceDecorated(rows, map, "json");
    const parsed = JSON.parse(json) as Array<ProvenanceMatrixRow & { resolved: unknown }>;
    // The JSON arm degrades to a STRUCTURED null marker — intentionally hint-free.
    // This is a SHAPE difference from the text arm (which shows TOKEN_HINT), and
    // this test pins it so the two arms can't silently drift. JSON consumers are
    // machines that read structured fields; `null` is their canonical "not
    // resolved" signal. The token-hint chrome belongs to the text/webapp surfaces.
    expect(parsed[0]?.resolved).toBeNull();
    expect(json).not.toContain("set SPEC_TRACKER_TOKEN");
    // Stable: same input → same bytes.
    expect(renderProvenanceDecorated(rows, map, "json")).toBe(json);
  });
});

describe("renderProvenance default path is unchanged", () => {
  test("json mode === JSON.stringify(sorted), text mode unchanged", () => {
    const rows = [prov("BILLING-9", "created", "ENG-1432")];
    expect(renderProvenance(rows, "json")).toBe(
      '[{"req_id":"BILLING-9","role":"created","issue_id":"ENG-1432","source_file":"spec-engine/BILLING/SPEC.md","line":1,"req_status":"Active","implemented":1,"verified":1,"test_levels":"unit,integration"}]',
    );
    const text = renderProvenance(rows, "text");
    expect(text).toContain("BILLING-9");
    expect(text).toContain("ENG-1432");
    expect(text).not.toContain("set SPEC_TRACKER_TOKEN");
  });
});
