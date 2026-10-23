import { describe, expect, test } from "bun:test";
import { formatStatementFinding, ruleSeverity, statementFindings } from "./statementRules";

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

  // @spec CHRT-025 unit
  test.each([
    "spec check shall exit 1, and the log shall name the file.",
    "spec check shall exit 1, and shall name the file.",
    "spec lint shall print every finding, and exit 1 when there is any.",
    "spec domain list shall print the keys, one per line, and exit 0.",
    "The results reader shall accept JUnit XML, and reject malformed XML.",
  ])("one-promise fails: %s", (statement) => {
    expect(rulesOf(statement)).toContain("one-promise");
  });

  // @spec CHRT-025 unit
  test.each([
    "When an unknown id is passed, spec resolve shall print [] and exit 0.",
    "The spec check command shall exit 1 when it reports an error-severity diagnostic and exit 0 otherwise.",
    "spec check shall apply its length limit, jargon list, exempt names, and rule severities.",
    "The tag scanner shall classify a tag as verifying when it is in a test, and as implementing otherwise.",
    "spec propagation shall list members in dependency order, and members at one depth by name.",
  ])("one-promise passes: %s", (statement) => {
    expect(rulesOf(statement)).not.toContain("one-promise");
  });

  // @spec CHRT-026 unit
  test.each([
    "spec mcp shall inject the charter via a filesystem read.",
    "The spec CLI shall locate the entry by scanning every domain file.",
    "The spec engine shall write every domain file through the validating writer.",
    "spec serve shall answer using the cached index.",
    "spec index shall finish by means of a second pass.",
  ])("no-mechanism fails: %s", (statement) => {
    expect(rulesOf(statement)).toContain("no-mechanism");
  });

  // @spec CHRT-026 unit
  test.each([
    "When a requirement is amended through the CLI, the HTTP API, or the MCP server, the spec engine shall write the same envelope.",
    "spec list shall order requirements by key.",
    "spec check shall grade the row by default as an error.",
  ])("no-mechanism passes: %s", (statement) => {
    expect(rulesOf(statement)).not.toContain("no-mechanism");
  });

  // @spec CHRT-027 unit
  test.each([
    "spec index shall report a diagnostic instead of rejecting the write.",
    "The reader shall treat malformed XML as a usage error rather than a diagnostic.",
    "spec check shall never fail the build but print a warning.",
    "spec resolve shall print not a path, an id.",
    "spec resolve shall print an id, not a path.",
  ])("no-contrast fails: %s", (statement) => {
    expect(rulesOf(statement)).toContain("no-contrast");
  });

  // @spec CHRT-027 unit
  test.each([
    "If the ref does not resolve, then spec guard shall exit 0.",
    "When the file is not tracked, spec check shall report it.",
    "spec gate shall exit 1 when the pin does not cover the requirement.",
  ])("no-contrast passes: %s", (statement) => {
    expect(rulesOf(statement)).not.toContain("no-contrast");
  });

  // @spec CHRT-028 unit
  test.each([
    "The README shall name spec init.",
    "The document states that ids are permanent.",
    "The table shall list every code.",
    "The agent reference's spec check section shall list every diagnostic code.",
    "AGENTS.md shall carry the authoring playbook.",
    "The TAXONOMY.md charter shall carry a scope sentence per domain.",
  ])("no-document-content fails: %s", (statement) => {
    expect(rulesOf(statement)).toContain("no-document-content");
  });

  // @spec CHRT-028 unit
  test.each([
    "The spec engine shall treat each spec-engine/ subdirectory holding a domain file as one domain.",
    "spec check shall report the section of the platform file that fails.",
    "spec index shall write one row per requirement to the table of requirements.",
  ])("no-document-content passes: %s", (statement) => {
    expect(rulesOf(statement)).not.toContain("no-document-content");
  });

  // @spec CHRT-029 unit
  test.each([
    "Where --json, spec lint shall print the findings as a sorted array.",
    "Where no REPO argument is given, spec init shall target the current directory.",
    "Where spec serve runs on a LAN address, it shall require the token.",
    "Where a value is passed, spec amend shall replace the list.",
  ])("where-takes-a-feature fails: %s", (statement) => {
    expect(rulesOf(statement)).toContain("where-takes-a-feature");
  });

  // @spec CHRT-029 unit
  test.each([
    "When spec lint runs with --json, it shall print the findings as a sorted array.",
    "Where an author_requirements request names a domain, spec mcp shall include that domain's charter.",
    "Where the editor feature is enabled, spec serve shall accept writes.",
  ])("where-takes-a-feature passes: %s", (statement) => {
    expect(rulesOf(statement)).not.toContain("where-takes-a-feature");
  });

  // @spec CHRT-030 unit
  test.each([
    "spec check shall surface the row, so a broken platform declaration fails the same gate a broken requirement does.",
    "spec check shall warn, so the gate stays green and CI passes.",
    "spec check shall warn, so the gate passes, quietly.",
  ])("no-trailing-commentary fails: %s", (statement) => {
    expect(rulesOf(statement)).toContain("no-trailing-commentary");
  });

  // @spec CHRT-030 unit
  test.each([
    "spec check shall report it at warning severity, so a lone warning never fails the gate.",
    "spec check shall warn, so the gate passes.",
    "spec check shall exit 1 so that CI stops.",
  ])("no-trailing-commentary passes: %s", (statement) => {
    expect(rulesOf(statement)).not.toContain("no-trailing-commentary");
  });

  // @spec CHRT-020 unit
  test.each([
    "self-member",
    "context walk",
    "canonical row",
    "layer",
    "corpus",
  ])("no-jargon fails on the default word %s", (word) => {
    expect(rulesOf(`The engine shall pin the ${word} first.`)).toContain("no-jargon");
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

// @spec CHRT-031 unit
describe("ruleSeverity", () => {
  test("no-trailing-commentary defaults to warning and every other rule to error", () => {
    expect(ruleSeverity("no-trailing-commentary", undefined)).toBe("warning");
    expect(ruleSeverity("one-promise", undefined)).toBe("error");
    expect(
      ruleSeverity("no-trailing-commentary", { severity: { "no-trailing-commentary": "error" } }),
    ).toBe("error");
  });
});
