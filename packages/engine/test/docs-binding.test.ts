// packages/engine/test/docs-binding.test.ts
//
// RED-15 integration: documentation lines bind to requirements through the
// full index pipeline, requirement changes surface bound doc lines on
// `spec check`, doc bindings never masquerade as code, and ambiguous
// prose mentions land in a derived doctor.md for triage.
//
// Runs against the COMMITTED fixtures/docs-fixture/ (read-only at the
// platform layer) with the DB in a per-suite tmpdir — the doctor.md
// artifact is written BESIDE the DB (dirname(storage.path)), never into
// the committed fixture tree.
//
// The fixture's planted mess (per CLAUDE.md, never "fix" it). NOTE: the
// binding token and ids are kept apart in these comments — this repo
// self-consumes and the code scanner matches the tag pattern anywhere in a
// .ts line, comments included (same reason test/fixtures/specTag.ts exists):
//   web/docs/guide.md:3   HTML-comment binding for DOCS-001 — valid
//   web/docs/guide.md:6   HTML-comment binding for DOCS-002 — superseded → SUPERSEDED_REFERENCED
//   web/docs/guide.md:9   HTML-comment binding for DOCS-999 — dangling → DANGLING_TAG
//   web/docs/guide.md:12  HTML-comment binding for DOCS-004 — doc-only (ORPHAN_REQ must still fire)
//   web/docs/guide.md:14  prose mention of DOCS-003 → doctor.md triage
//   web/docs/guide.md:16  JIRA-123 (unknown id shape) → ignored
//   web/docs/guide.md:21  code-comment tag for EXAMPLE-001 inside a fenced block → must NOT bind

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { IndexResult, Storage } from "@spec-engine/shared";
import { collectDiagnostics } from "../src/check/sqlDiagnostics";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "docs-fixture");

let tmp: string;
let storage: Storage;
let result: IndexResult;
let doctorPath: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "spec-docs-binding-"));
  const dbPath = join(tmp, "index.sqlite");
  storage = openStorage(dbPath);
  result = await runIndex({ platformDir: FIXTURE, storage });
  doctorPath = join(dirname(dbPath), "doctor.md");
});

afterAll(() => {
  storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("doc bindings index as documents-kind tags (RED-15)", () => {
  test("index counts 2 code tags + 4 doc bindings = 6 tags; code-block example does NOT bind", () => {
    expect(result.tags).toBe(6);
  });

  test("resolve on the doc file returns the requirements its bindings point at", () => {
    // DOCS-999 is dangling (no requirement row) so the join drops it;
    // DOCS-001 / DOCS-002 / DOCS-004 come back in (key, seq) order.
    const ids = storage.resolveByFiles(["web/docs/guide.md"]).map((r) => r.id);
    expect(ids).toEqual(["DOCS-001", "DOCS-002", "DOCS-004"]);
  });

  test("no phantom EXAMPLE-001 tag anywhere (criterion 1: code-block examples never bind)", () => {
    const codes = collectDiagnostics(storage);
    expect(codes.some((d) => d.req_id === "EXAMPLE-001")).toBe(false);
  });
});

describe("req→doc direction: requirement changes surface bound doc lines (RED-15)", () => {
  test("doc binding to a superseded requirement fires SUPERSEDED_REFERENCED at the doc line", () => {
    const hit = collectDiagnostics(storage).find(
      (d) => d.code === "SUPERSEDED_REFERENCED" && d.req_id === "DOCS-002",
    );
    expect(hit).toBeDefined();
    expect(hit?.source_file).toBe("web/docs/guide.md");
    expect(hit?.line).toBe(6);
  });

  test("doc binding to a nonexistent requirement fires DANGLING_TAG at the doc line", () => {
    const hit = collectDiagnostics(storage).find(
      (d) => d.code === "DANGLING_TAG" && d.req_id === "DOCS-999",
    );
    expect(hit).toBeDefined();
    expect(hit?.source_file).toBe("web/docs/guide.md");
    expect(hit?.line).toBe(9);
  });
});

describe("doc bindings never masquerade as code (RED-15)", () => {
  test("a doc-only-bound Active requirement still reports ORPHAN_REQ", () => {
    // DOCS-004 is bound ONLY by the HTML-comment binding in guide.md. A doc
    // binding is not an implementation — orphan detection must see through it.
    const codes = collectDiagnostics(storage)
      .filter((d) => d.code === "ORPHAN_REQ")
      .map((d) => d.req_id);
    expect(codes).toContain("DOCS-004");
    // DOCS-003 (prose mention only, no binding at all) is also orphaned.
    expect(codes).toContain("DOCS-003");
  });

  test("coverage stays 0/0 for the doc-only binding; src+test for the code-tagged req", () => {
    const matrix = storage.coverageMatrix();
    const doc = matrix.find((r) => r.req_id === "DOCS-004" && r.repo === "web");
    expect(doc).toBeDefined();
    expect(doc?.implemented).toBe(0);
    expect(doc?.verified).toBe(0);
    const code = matrix.find((r) => r.req_id === "DOCS-001" && r.repo === "web");
    expect(code?.implemented).toBe(1);
    expect(code?.verified).toBe(1);
  });

  test("propagation ignores documents-kind tags: web is ON_OTHER_DOMAIN_REQ, not ON_PREDECESSOR", () => {
    // web's doc binds DOCS-002 (the predecessor of DOCS-003). If documents
    // tags leaked into propagation, web would classify ON_PREDECESSOR. With
    // the exclusion, web's only signal is its CODE tag on DOCS-001 (another
    // req in the same domain) → ON_OTHER_DOMAIN_REQ via DOCS-001.
    const rows = storage.propagationFor("DOCS-003");
    const web = rows.find((r) => r.repo === "web");
    expect(web?.state).toBe("ON_OTHER_DOMAIN_REQ");
    expect(web?.via_req_id).toBe("DOCS-001");
  });
});

describe("doctor.md ambiguity triage (RED-15)", () => {
  test("doctor.md is written beside the index DB", () => {
    expect(existsSync(doctorPath)).toBe(true);
  });

  test("an unbound mention of a known requirement id is listed with file:line", () => {
    const doctor = readFileSync(doctorPath, "utf8");
    expect(doctor).toContain("web/docs/guide.md:14");
    expect(doctor).toContain("DOCS-003");
  });

  test("bound lines, unknown id shapes, and code-block examples are NOT listed", () => {
    const doctor = readFileSync(doctorPath, "utf8");
    expect(doctor).not.toContain("JIRA-123");
    expect(doctor).not.toContain("EXAMPLE-001");
    // The binding lines bind their ids — none of them is ambiguous.
    expect(doctor).not.toContain("guide.md:3");
    expect(doctor).not.toContain("guide.md:6");
    expect(doctor).not.toContain("guide.md:9");
    expect(doctor).not.toContain("guide.md:12");
  });

  test("doctor.md regenerates deterministically (cold-rebuild equivalence)", async () => {
    const first = readFileSync(doctorPath, "utf8");
    const tmp2 = mkdtempSync(join(tmpdir(), "spec-docs-binding-2-"));
    const s2 = openStorage(join(tmp2, "index.sqlite"));
    try {
      const r2 = await runIndex({ platformDir: FIXTURE, storage: s2 });
      expect(r2.build_id).toBe(result.build_id);
      const second = readFileSync(join(tmp2, "doctor.md"), "utf8");
      expect(second).toBe(first);
    } finally {
      s2.close();
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});
