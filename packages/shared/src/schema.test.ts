// @spec SCHM-011 unit

import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { DDL, DiagnosticCode, SCHEMA_VERSION, SpecConfigSchema } from "./index";

test("DDL contains no CHECK / FOREIGN KEY / UNIQUE on domain fields", () => {
  // Bound to the constant, not a literal, so a version bump does not churn this test.
  expect(typeof SCHEMA_VERSION).toBe("number");
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
  expect(/CHECK\s*\(/.test(DDL)).toBe(false);
  expect(/FOREIGN\s+KEY/i.test(DDL)).toBe(false);
  // PRIMARY KEY is allowed and not matched.
  expect(/^\s*UNIQUE\s*\(/m.test(DDL)).toBe(false);
});

// @spec SCHM-016 unit
test("SCHEMA_VERSION is 11 and DDL carries the TERM substrate, superseded_at_version, and dependency_depth", () => {
  expect(SCHEMA_VERSION).toBe(11);
  expect(DDL).toContain("term_citations");
  expect(DDL).toContain("term_aliases");
  expect(DDL).toContain("term_drift");
  expect(DDL).toContain("r.key != 'TERM'");
  expect(DDL).toContain("superseded_at_version INTEGER");
  expect(DDL).toContain("dependency_depth      INTEGER NOT NULL");
});

test("DDL contains required tables, FTS5 external-content table, coverage VIEW, FTS triggers", () => {
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

test("No .sql files exist anywhere under packages/", async () => {
  // Anchored to import.meta.dir: resolved against cwd, a run from
  // packages/shared/ would scan a missing root and pass vacuously.
  const repoRoot = resolve(import.meta.dir, "..", "..", "..");
  const packagesRoot = join(repoRoot, "packages");

  // A known .ts file must be found, or an empty .sql match is vacuous.
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

test("the version-columns comment block names every version column and the drift predicate", async () => {
  const text = await Bun.file(new URL("./schema.ts", import.meta.url)).text();
  expect(text).toContain("domains.spec_version");
  expect(text).toContain("requirements.spec_version");
  expect(text).toContain("requirements.changed_at_version");
  expect(text).toContain("repos.pinned_spec_version");
  expect(text).toContain("repos.dependency_depth");
  expect(text).toContain("Drift predicate");
});

test("DiagnosticCode carries the nine core codes", () => {
  expect(DiagnosticCode.DUP_ID).toBe("DUP_ID");
  expect(DiagnosticCode.BROKEN_SUPERSEDE).toBe("BROKEN_SUPERSEDE");
  expect(DiagnosticCode.BAD_STATUS).toBe("BAD_STATUS");
  expect(DiagnosticCode.DANGLING_TAG).toBe("DANGLING_TAG");
  expect(DiagnosticCode.SUPERSEDED_REFERENCED).toBe("SUPERSEDED_REFERENCED");
  expect(DiagnosticCode.ORPHAN_REQ).toBe("ORPHAN_REQ");
  expect(DiagnosticCode.UNVERIFIED_REQ).toBe("UNVERIFIED_REQ");
  expect(DiagnosticCode.DRIFT).toBe("DRIFT");
  expect(DiagnosticCode.NO_SPEC_CONFIG).toBe("NO_SPEC_CONFIG");
});

test("SpecConfigSchema accepts a spec-engine@N pin and rejects a malformed or missing one", () => {
  expect(SpecConfigSchema.safeParse({ specs: "spec-engine@2" }).success).toBe(true);
  expect(SpecConfigSchema.safeParse({ specs: "spec-engine@notanumber" }).success).toBe(false);
  expect(SpecConfigSchema.safeParse({}).success).toBe(false);
});

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
