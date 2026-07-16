// packages/engine/test/provenance-test-levels-dedup.test.ts
//
// WR-01 / IN-03 (13-REVIEW review-fix) regression lock: the
// `provenance_matrix` VIEW must NOT double-count a test level that appears in
// more than one member repo for the same requirement.
//
// Root cause (pre-fix): the `coverage` VIEW aggregates `test_levels` per
// (req_id, repo) into a single comma-joined string (api -> "unit,integration",
// mobile -> "unit"). The `provenance_matrix` VIEW then did
// GROUP_CONCAT(DISTINCT c.test_levels) over those WHOLE strings, so a level
// present in two repos leaked through twice ("unit,integration,unit"). The fix
// re-aggregates at the individual-level granularity via a correlated subquery
// over `tags` (DISTINCT t2.level ... ORDER BY level).
//
// This test seeds a tmp file-DB directly with the canonical DDL (mirroring
// storage.test.ts's `new Database(path)` seeding pattern) so it exercises the
// REAL VIEW aggregation across multiple repos — the gap IN-03 calls out, where
// the existing format/snapshot tests hand-build `test_levels` and never hit
// the VIEW's cross-repo path. It also renders through the pure formatter so
// the command-level surface (`src+test (unit)`) is asserted, not just the row.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DDL, SCHEMA_VERSION } from "@spec-engine/shared";
import { renderProvenance } from "../src/provenance/format";
import { openStorage } from "../src/storage/sqlite";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-prov-levels-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Seed a minimal derived index: one Active requirement, two member repos,
 *  one provenance link, and `tags` whose `unit` level appears in BOTH repos
 *  (plus `integration` in only one). Pre-fix, the VIEW emitted
 *  "unit,integration,unit"; post-fix it must emit each level exactly once. */
function seed(path: string): void {
  // Under `strict: true`, bun:sqlite expects bind-object keys WITHOUT the
  // leading `$` sigil (the `$name` placeholder matches the JS key `name`).
  // This mirrors the convention documented in storage/sqlite.ts's upsert*.
  const db = new Database(path, { create: true, strict: true });
  db.exec(DDL);
  db.run("INSERT INTO _schema_version (version) VALUES (?)", [SCHEMA_VERSION]);

  const insRepo = db.prepare(
    "INSERT INTO repos (name, path, pinned_spec_version) VALUES ($n, $p, $v)",
  );
  insRepo.run({ n: "api", p: "/x/api", v: 1 });
  insRepo.run({ n: "mobile", p: "/x/mobile", v: 1 });

  db.prepare(
    "INSERT INTO requirements (id, key, seq, status, superseded_by, text, why, source_file, line, spec_version, changed_at_version) " +
      "VALUES ($id, $key, $seq, $status, NULL, $text, NULL, $src, $line, 1, 1)",
  ).run({
    id: "BILLING-050",
    key: "BILLING",
    seq: 50,
    status: "Active",
    text: "A requirement verified at the unit level in two repos.",
    src: "spec-engine/BILLING/SPEC.md",
    line: 5,
  });

  db.prepare(
    "INSERT INTO provenance (req_id, issue_id, role, source_file, line) VALUES ($r, $i, $role, $src, $line)",
  ).run({
    r: "BILLING-050",
    i: "ENG-9001",
    role: "created",
    src: "spec-engine/BILLING/SPEC.md",
    line: 5,
  });

  // tags: `unit` verifies in BOTH api and mobile (the duplicate trigger), plus
  // `integration` in api only, and an implements tag so backingTests = src+test.
  const tagRows = [
    { repo: "api", file: "api/src/billing.ts", line: 1, kind: "implements", level: null },
    { repo: "api", file: "api/test/billing.test.ts", line: 1, kind: "verifies", level: "unit" },
    {
      repo: "api",
      file: "api/test/billing.int.test.ts",
      line: 1,
      kind: "verifies",
      level: "integration",
    },
    {
      repo: "mobile",
      file: "mobile/test/billing.test.ts",
      line: 1,
      kind: "verifies",
      level: "unit",
    },
  ];
  const insTag = db.prepare(
    "INSERT INTO tags (req_id, repo, file, line, kind, level) VALUES ($r, $repo, $f, $l, $k, $lvl)",
  );
  for (const t of tagRows) {
    insTag.run({ r: "BILLING-050", repo: t.repo, f: t.file, l: t.line, k: t.kind, lvl: t.level });
  }
  db.close();
}

describe("provenance_matrix test_levels — no cross-repo double-count (WR-01/IN-03)", () => {
  test("a unit level present in two repos renders exactly once in the VIEW row", () => {
    seed(dbPath);
    const s = openStorage(dbPath);
    try {
      const rows = s.provenanceMatrix();
      const row = rows.find((r) => r.req_id === "BILLING-050");
      expect(row).toBeDefined();
      const levels = (row?.test_levels ?? "").split(",").filter(Boolean);
      // Each level appears exactly once — no "unit,integration,unit".
      expect(levels).toEqual(["integration", "unit"]); // ORDER BY level
      expect(levels.filter((l) => l === "unit").length).toBe(1);
    } finally {
      s.close();
    }
  });

  test("the rendered backing-test cell shows each level once (command surface)", () => {
    seed(dbPath);
    const s = openStorage(dbPath);
    try {
      const rows = s.provenanceMatrix();
      const text = renderProvenance(rows, "text");
      // src+test because implements + verifies both present; levels deduped.
      expect(text).toContain("src+test (integration,unit)");
      // Belt-and-suspenders: the pre-fix duplicate must NOT appear anywhere.
      expect(text).not.toContain("unit,integration,unit");
      expect(text).not.toMatch(/unit[^)]*unit/);
    } finally {
      s.close();
    }
  });
});
