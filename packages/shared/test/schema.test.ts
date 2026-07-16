//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec SCHM-001 unit

import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { DDL, DiagnosticCode, SCHEMA_VERSION, SpecConfigSchema } from "../src/index";

test("DDL contains no CHECK / FOREIGN KEY / UNIQUE on domain fields (SCHM-07)", () => {
  // SCHEMA_VERSION is bound to the imported constant (Phase 3 decision):
  // version bumps must not churn tests. Type + positivity invariants only.
  expect(typeof SCHEMA_VERSION).toBe("number");
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
  // CHECK( clauses are forbidden (D-03 / Invariant #4).
  expect(/CHECK\s*\(/.test(DDL)).toBe(false);
  // FOREIGN KEY clauses are forbidden (D-03 / Invariant #4).
  expect(/FOREIGN\s+KEY/i.test(DDL)).toBe(false);
  // Stand-alone UNIQUE() clauses are forbidden (PRIMARY KEY is allowed and not matched).
  expect(/^\s*UNIQUE\s*\(/m.test(DDL)).toBe(false);
});

// Phase 6 Plan 01 — Wave 0 RED: SCHEMA_VERSION 9 + the TERM derived-table
// substrate. Terms are requirement rows excluded from CODE coverage; the two
// new derived tables (term_aliases, term_citations) mirror `relations`, and the
// coverage VIEW must drop key='TERM' so a migrated glossary term never fires a
// coverage error. RED now: SCHEMA_VERSION is still 8 and the DDL carries none of
// these strings. Goes GREEN when Plan 06-01 Task 2 lands the schema changes.
// @spec SCHM-005 unit
test("SCHEMA_VERSION is 10 and DDL carries the TERM substrate + superseded_at_version column", () => {
  expect(SCHEMA_VERSION).toBe(10);
  expect(DDL).toContain("term_citations");
  expect(DDL).toContain("term_aliases");
  // The term-drift VIEW skeleton (term citation pin < term's changed_at_version).
  expect(DDL).toContain("term_drift");
  // The coverage VIEW excludes the reserved TERM domain from code coverage.
  expect(DDL).toContain("r.key != 'TERM'");
  // v10: the immutable "version this requirement died at" column.
  expect(DDL).toContain("superseded_at_version INTEGER");
});

test("DDL contains required tables, FTS5 external-content table, coverage VIEW, FTS triggers (SCHM-01..06, SCHM-08)", () => {
  expect(DDL).toContain("CREATE TABLE IF NOT EXISTS _schema_version");
  expect(DDL).toContain("CREATE TABLE IF NOT EXISTS repos");
  expect(DDL).toContain("CREATE TABLE IF NOT EXISTS domains");
  expect(DDL).toContain("CREATE TABLE IF NOT EXISTS requirements");
  expect(DDL).toContain("CREATE TABLE IF NOT EXISTS tags");
  expect(DDL).toContain("CREATE TABLE IF NOT EXISTS parse_diagnostics");
  expect(DDL).toContain("changed_at_version    INTEGER NOT NULL");
  expect(DDL).toContain("CREATE VIRTUAL TABLE IF NOT EXISTS requirements_fts USING fts5(");
  expect(DDL).toContain("content='requirements'");
  expect(DDL).toContain("content_rowid='rowid'");
  expect(DDL).toContain("CREATE VIEW IF NOT EXISTS coverage AS");
  expect(DDL).toContain("CREATE TRIGGER IF NOT EXISTS requirements_ai");
  expect(DDL).toContain("CREATE TRIGGER IF NOT EXISTS requirements_ad");
  expect(DDL).toContain("CREATE TRIGGER IF NOT EXISTS requirements_au");
});

test("No .sql files exist anywhere under packages/ (SCHM-08)", async () => {
  // Anchor the scan root to a path resolved from `import.meta.dir` so the
  // test is location-independent. Without this anchor, `glob.scan("packages")`
  // resolves against `process.cwd()` — running `bun test` from
  // `packages/shared/` would make the search root missing, silently
  // returning zero matches and passing vacuously even if a stray `.sql`
  // file were committed somewhere under `packages/` (WR-03).
  //
  // schema.test.ts lives at packages/shared/test/schema.test.ts; going up
  // three levels reaches the monorepo root that contains `packages/`.
  const repoRoot = resolve(import.meta.dir, "..", "..", "..");
  const packagesRoot = join(repoRoot, "packages");

  // Sanity-check: at least one known `.ts` file must be discoverable from
  // the resolved root, so that an empty `.sql` match set isn't a vacuous
  // pass caused by a misresolved search root.
  const tsGlob = new Bun.Glob("**/*.ts");
  const tsSentinel: string[] = [];
  for await (const match of tsGlob.scan({ cwd: packagesRoot })) {
    tsSentinel.push(match);
    if (tsSentinel.length > 0) break;
  }
  expect(tsSentinel.length).toBeGreaterThan(0);

  const glob = new Bun.Glob("**/*.sql");
  const matches: string[] = [];
  for await (const match of glob.scan({ cwd: packagesRoot })) {
    matches.push(match);
  }
  expect(matches).toEqual([]);
});

test("Version semantics comment block defines all four version columns and DRIFT predicate (D-02)", async () => {
  const text = await Bun.file(new URL("../src/schema.ts", import.meta.url)).text();
  expect(text).toContain("domains.spec_version");
  expect(text).toContain("requirements.spec_version");
  expect(text).toContain("requirements.changed_at_version");
  expect(text).toContain("repos.pinned_spec_version");
  expect(text).toContain("DRIFT predicate");
});

test("DiagnosticCode enum has all 10 codes per REQUIREMENTS.md (260605-tqz BROKEN_FILE_REF)", () => {
  expect(DiagnosticCode.DUP_ID).toBe("DUP_ID");
  expect(DiagnosticCode.BROKEN_SUPERSEDE).toBe("BROKEN_SUPERSEDE");
  expect(DiagnosticCode.BAD_STATUS).toBe("BAD_STATUS");
  expect(DiagnosticCode.DANGLING_TAG).toBe("DANGLING_TAG");
  expect(DiagnosticCode.SUPERSEDED_REFERENCED).toBe("SUPERSEDED_REFERENCED");
  expect(DiagnosticCode.ORPHAN_REQ).toBe("ORPHAN_REQ");
  expect(DiagnosticCode.UNVERIFIED_REQ).toBe("UNVERIFIED_REQ");
  expect(DiagnosticCode.DRIFT).toBe("DRIFT");
  expect(DiagnosticCode.NO_SPEC_CONFIG).toBe("NO_SPEC_CONFIG");
  expect(DiagnosticCode.BROKEN_FILE_REF).toBe("BROKEN_FILE_REF");
});

test("SpecConfigSchema validates and rejects per Phase 2 contract", () => {
  expect(SpecConfigSchema.safeParse({ specs: "spec-engine@2" }).success).toBe(true);
  expect(SpecConfigSchema.safeParse({ specs: "spec-engine@notanumber" }).success).toBe(false);
  expect(SpecConfigSchema.safeParse({}).success).toBe(false);
});

// Audit hygiene pass T7 — optional per-repo `ignore` field.
test("SpecConfigSchema accepts an optional ignore array of non-empty strings", () => {
  expect(
    SpecConfigSchema.safeParse({ specs: "spec-engine@1", ignore: ["generated", "vendor/"] })
      .success,
  ).toBe(true);
  expect(SpecConfigSchema.safeParse({ specs: "spec-engine@1", ignore: [] }).success).toBe(true);
  expect(SpecConfigSchema.safeParse({ specs: "spec-engine@1", ignore: "generated" }).success).toBe(
    false,
  );
  expect(SpecConfigSchema.safeParse({ specs: "spec-engine@1", ignore: [""] }).success).toBe(false);
  expect(SpecConfigSchema.safeParse({ specs: "spec-engine@1", ignore: [42] }).success).toBe(false);
});
