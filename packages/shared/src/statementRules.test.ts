import { describe, expect, test } from "bun:test";
import { formatStatementFinding, statementFindings } from "./statementRules";

const rulesOf = (statement: string, config = {}) =>
  statementFindings(statement, config).map((f) => f.rule);

describe("statementFindings", () => {
  test("passes one observable sentence", () => {
    expect(
      statementFindings(
        "A member cannot read another tenant's rows, e.g. through `TenantDb`, in v1.2.3 or later.",
      ),
    ).toEqual([]);
  });

  // @spec CHRT-014 unit
  test.each([
    "A user signs in. A user signs out.",
    "A user signs in\nand out.",
    "A user signs in",
  ])("one-sentence fails: %s", (statement) => {
    expect(rulesOf(statement)).toContain("one-sentence");
  });

  // @spec CHRT-015 unit
  test("length fails over 280 characters", () => {
    expect(rulesOf(`A user can sign in${" and sign out".repeat(25)}.`)).toContain("length");
  });

  // @spec CHRT-016 unit
  test.each([
    "The handler in `apps/api/src/routes` refuses it.",
    "The value is declared in `supabase/config.toml`.",
    "The rule lives in schema.sql only.",
  ])("no-file-path fails: %s", (statement) => {
    expect(rulesOf(statement)).toContain("no-file-path");
  });

  // @spec CHRT-016 unit
  test("a backticked job name with one slash and no extension is not a path", () => {
    expect(rulesOf("The `platform/purge` job deletes expired tenants.")).toEqual([]);
  });

  // @spec CHRT-017 unit
  test.each([
    "The test fails when a job is unregistered.",
    "A planted secret fails the scan.",
  ])("no-test-narration fails: %s", (statement) => {
    expect(rulesOf(statement)).toContain("no-test-narration");
  });

  // @spec CHRT-018 unit
  test.each([
    "The CI workflow runs the lint stage.",
    "A raw hex fails `pnpm ci:test`.",
  ])("no-toolchain-layout fails: %s", (statement) => {
    expect(rulesOf(statement)).toContain("no-toolchain-layout");
  });

  // @spec CHRT-019 unit
  test.each([
    "The endpoint previously answered 404.",
    "This rule supersedes CONFIG-012.",
  ])("no-history fails: %s", (statement) => {
    expect(rulesOf(statement)).toContain("no-history");
  });

  // @spec CHRT-020 unit
  test("no-jargon fails on a default jargon word", () => {
    expect(rulesOf("Every writer gets the value from one seam.")).toContain("no-jargon");
  });

  // @spec CHRT-021 unit
  test.each([
    "The harness is pinned to `@electric-sql/pglite` 0.4.6.",
    "We use pg-boss for jobs.",
  ])("no-tool-statement fails: %s", (statement) => {
    expect(rulesOf(statement)).toContain("no-tool-statement");
  });

  test.each([
    "A job carries a Zod-validated payload and a failed job is retried.",
    "Line coverage on the tenancy floor stays above 80%.",
    "The web app renders with Next.js and the dashboard reads through `@kit/users`.",
    "An info role exists alongside ok/warn/destructive.",
    "An export for a tenant that no longer exists records a failure.",
    "`pnpm db:reset` leaves the local database migrated and seeded.",
    "An expired invitation is closed and replaced, and the hook runs on `preValidation`.",
    "Button exposes a style by size variant matrix, and the tenant that is pinned is the key row's.",
    "Analytics posts to `https://eu.example.com/capture` and seeds three fixture accounts.",
    "The published @spec-engine/spec-engine tarball holds only the built payload.",
  ])("does not flag behaviour: %s", (statement) => {
    expect(statementFindings(statement)).toEqual([]);
  });

  test("a finding prints as rule, detail, and reason", () => {
    const [finding] = statementFindings("We use pg-boss for jobs.");
    expect(finding && formatStatementFinding(finding)).toBe(
      'no-tool-statement: "We use" — naming the tool in use is a decision record, not a requirement',
    );
  });
});

// @spec CHCK-057 unit
describe("statementFindings under a configuration", () => {
  test("maxLength replaces the 280-character default", () => {
    expect(rulesOf("A user signs in.", { maxLength: 10 })).toEqual(["length"]);
    expect(rulesOf(`A user can sign in${" and sign out".repeat(25)}.`, { maxLength: 400 })).toEqual(
      [],
    );
  });

  test("jargon replaces the default word list", () => {
    const config = { jargon: ["widget"] };
    expect(rulesOf("Every writer gets the value from one seam.", config)).toEqual([]);
    expect(rulesOf("Every widget renders once.", config)).toEqual(["no-jargon"]);
  });

  test("an exempt name passes no-file-path, and a name ending in a slash exempts the path under it", () => {
    const config = { exemptNames: ["SPEC.json", "spec-engine/"] };
    expect(rulesOf("Each domain keeps one SPEC.json.", config)).toEqual([]);
    expect(rulesOf("A domain lives at `spec-engine/BILLING/SPEC.json`.", config)).toEqual([]);
    expect(rulesOf("The rule lives in schema.sql only.", config)).toEqual(["no-file-path"]);
  });

  test("a rule set to off is never reported", () => {
    const config = { severity: { "no-history": "off" as const } };
    expect(rulesOf("The endpoint previously answered 404.", config)).toEqual([]);
  });
});
