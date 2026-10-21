// The DB is seeded directly with the DDL so the real VIEW aggregates across
// repos: hand-built `test_levels` rows never reach that path.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DDL, SCHEMA_VERSION } from "@spec-engine/shared";
import { openStorage } from "../storage/sqlite";
import { renderProvenance } from "./format";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-prov-levels-"));
  dbPath = join(tmp, "index.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seed(path: string): void {
  // Under `strict: true`, bun:sqlite expects bind-object keys WITHOUT the
  // leading `$` sigil (the `$name` placeholder matches the JS key `name`).
  // This mirrors the convention documented in storage/sqlite.ts's upsert*.
  const db = new Database(path, { create: true, strict: true });
  db.exec(DDL);
  db.run("INSERT INTO _schema_version (version) VALUES (?)", [SCHEMA_VERSION]);

  const insRepo = db.prepare(
    "INSERT INTO repos (name, path, pinned_spec_version, dependency_depth) VALUES ($n, $p, $v, 0)",
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

describe("provenance_matrix test_levels — no cross-repo double-count", () => {
  test("a unit level present in two repos renders exactly once in the VIEW row", () => {
    seed(dbPath);
    const s = openStorage(dbPath);
    try {
      const rows = s.provenanceMatrix();
      const row = rows.find((r) => r.req_id === "BILLING-050");
      expect(row).toBeDefined();
      const levels = (row?.test_levels ?? "").split(",").filter(Boolean);
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
      expect(text).toContain("src+test (integration,unit)");
      expect(text).not.toContain("unit,integration,unit");
      expect(text).not.toMatch(/unit[^)]*unit/);
    } finally {
      s.close();
    }
  });
});
