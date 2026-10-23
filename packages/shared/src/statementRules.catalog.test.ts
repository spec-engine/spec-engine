import { describe, expect, test } from "bun:test";
import { type StatementRule, statementFindings } from "./statementRules";

const WORDING_RULES: readonly StatementRule[] = [
  "one-promise",
  "no-mechanism",
  "no-contrast",
  "no-document-content",
  "where-takes-a-feature",
  "no-trailing-commentary",
];

const rulesOf = (statement: string) => statementFindings(statement).map((f) => f.rule);

const FLAGGED: readonly [id: string, rule: StatementRule, statement: string][] = [
  [
    "AUTHOR-009",
    "no-mechanism",
    "Where a target domain accompanies an author_requirements request, spec mcp shall inject that domain's charter scope into the returned playbook via a filesystem read of its SPEC.json.",
  ],
  [
    "REQ-048",
    "no-mechanism",
    "When a lifecycle command targets an id whose prefix names no domain file holding that entry, the spec CLI shall locate the entry by scanning every domain file.",
  ],
  [
    "CHCK-052",
    "where-takes-a-feature",
    "Where --json, spec lint shall print the findings as a sorted array.",
  ],
  [
    "INDX-010",
    "one-promise",
    "The tag scanner shall recognize an @spec KEY-NNN tag anywhere in a line regardless of comment style, and shall record the optional trailing level token only when it is unit, integration, or e2e.",
  ],
  [
    "CHCK-032",
    "one-promise",
    "The spec engine shall raise ORPHAN_REQ and UNVERIFIED_REQ only for Active requirements, and shall count only Active requirements in the coverage report.",
  ],
  [
    "PROOF-009",
    "one-promise",
    "The results reader shall accept JUnit XML as emitted by any test runner without per-runner configuration, and shall reject malformed XML as a usage error rather than a diagnostic.",
  ],
  [
    "CHCK-031",
    "no-trailing-commentary",
    "When platform-map reports a diagnostic for the platform that is an error or a warning, or an info that means a repository's tags go unscanned, spec check shall surface it as a diagnostic row with the platform-map code, so a broken platform declaration fails the same gate a broken requirement does.",
  ],
  [
    "INIT-035",
    "no-trailing-commentary",
    "Where a platform directory is a lone repository with no platform file, discovery shall register the map's one repo as a single coverage column, or one column per workspace package when it is a monorepo, so its @spec tags index with no member config and no CI gate.",
  ],
  [
    "INDX-008",
    "no-contrast",
    "If a parsed spec contains a duplicate id, a broken supersede reference, or an invalid status, then spec index shall complete the build and report a DUP_ID, BROKEN_SUPERSEDE, or BAD_STATUS diagnostic instead of rejecting the write.",
  ],
  [
    "PROOF-009",
    "no-contrast",
    "The results reader shall accept JUnit XML as emitted by any test runner without per-runner configuration, and shall reject malformed XML as a usage error rather than a diagnostic.",
  ],
  [
    "SCHM-028",
    "no-contrast",
    "The derived index schema shall declare no CHECK, FOREIGN KEY, or UNIQUE constraint on a domain field, so a spec defect lands as a diagnostic row instead of a failed insert.",
  ],
  [
    "CHRT-007",
    "no-document-content",
    "The spec-engine/TAXONOMY.md charter document shall carry, for every domain, a scope sentence plus belongs-here and does-not-belong-here lists with at least one named boundary case.",
  ],
  [
    "CHRT-013",
    "no-document-content",
    "The spec-engine/TAXONOMY.md charter document shall catalogue the platform's headline invariants in a table naming, for each, the owning domain and the requirement id that records it.",
  ],
  [
    "DIST-012",
    "no-document-content",
    "The README shall name spec init and the NO_SPEC_CONFIG diagnostic, so an adopter reading the warning can find the command that clears it.",
  ],
  [
    "INIT-028",
    "no-jargon",
    "When discovery registers the canonical spec-engine row and the lone-repo self-member, it shall pin both to the derived platform version, so a lone repo is never reported drifted against its own working-tree domains.",
  ],
  [
    "AUTHOR-006",
    "no-jargon",
    "While a drafted requirement batch awaits human approval, the req-author skill shall write nothing to the corpus \u2014 no spec req invocation runs until the human explicitly approves the batch.",
  ],
];

const REWRITTEN: readonly [id: string, statement: string][] = [
  [
    "AUTHOR-006",
    "While a drafted requirement batch awaits human approval, the req-author skill shall write nothing to any SPEC.json.",
  ],
  [
    "AUTHOR-008",
    "When an author_requirements prompt is requested, spec mcp shall return the static authoring playbook with the brief substituted verbatim.",
  ],
  [
    "AUTHOR-009",
    "Where an author_requirements request names a domain, spec mcp shall include that domain's charter in the returned playbook.",
  ],
  [
    "CHCK-025",
    "When a declared member has no spec-engine.member.json, spec check shall report NO_SPEC_CONFIG at warning severity with a spec init suggestion for that member.",
  ],
  [
    "CHCK-031",
    "When platform-map reports an error, a warning, or an unscanned repository for the platform, spec check shall report it as a row under the platform-map code.",
  ],
  [
    "CHCK-032",
    "The spec check command shall raise ORPHAN_REQ and UNVERIFIED_REQ for Active requirements only.",
  ],
  [
    "CHCK-040",
    "If a domain declares the ears grammar and an Active or Draft statement chains a second promise or states a rationale, then spec check shall report STATEMENT_GRAMMAR at the domain's declared severity.",
  ],
  [
    "CHCK-043",
    "The spec check command shall exit 1 when it reports an error-severity diagnostic and exit 0 otherwise.",
  ],
  [
    "CHCK-048",
    "When check.json configures statement rules, spec check, spec lint, and the authoring commands shall apply its length limit, jargon list, exempt names, and rule severities.",
  ],
  ["CHCK-052", "When spec lint runs with --json, it shall print the findings as a sorted array."],
  [
    "DIST-007",
    "The spec docs command shall serve the same documentation site from any working directory.",
  ],
  [
    "DIST-009",
    "When the published spec command runs under a runtime other than Bun, it shall exit 1 with a hint to install Bun.",
  ],
  [
    "DIST-011",
    "The published spec package shall install from the npm registry without a repository checkout.",
  ],
  [
    "DOMAIN-011",
    "When spec domain new receives a name, it shall uppercase the name and remove all whitespace before validating it.",
  ],
  [
    "DOMAIN-016",
    "The spec engine shall treat each spec-engine/ subdirectory that holds a SPEC.json as a domain.",
  ],
  [
    "DOMAIN-019",
    "When spec domain new scaffolds a domain, it shall write a SPEC.json that spec index ingests with zero diagnostics.",
  ],
  [
    "GATE-008",
    "When spec gate runs for a member and a requirement, it shall exit 0 only when the requirement is Active and the member's pin is at or above its changed_at_version.",
  ],
  [
    "GUARD-013",
    "When spec guard finds a loss against the given git ref, HEAD by default, it shall report the loss and exit 1.",
  ],
  [
    "GUARD-020",
    "When spec guard runs with --json, it shall print the loss rows sorted by requirement id, kind, file, and line.",
  ],
  [
    "GUARD-025",
    "The spec check command shall report IMPL_LOST and SPEC_FILE_DELETED at error severity.",
  ],
  [
    "INDX-008",
    "If a domain file holds a duplicate id, a broken supersede, or an invalid status, then spec index shall complete the build and report the matching diagnostic.",
  ],
  [
    "INDX-009",
    "When spec index runs, it shall report the build_id and the counts of repos, domains, requirements, tags, and diagnostics.",
  ],
  [
    "INDX-010",
    "The tag scanner shall recognize a requirement tag written with any comment leader anywhere in a line.",
  ],
  [
    "INDX-011",
    "The tag scanner shall classify a tag as verifying when its file path matches a supported test-path pattern, and as implementing otherwise.",
  ],
  ["INDX-012", "The indexer shall resolve a term citation by TERM id, by headword, or by alias."],
  [
    "INDX-018",
    "Where a member config lists ignore directories, the tag scanner shall skip each one as a prefix of the path from the repository root.",
  ],
  [
    "INIT-027",
    "When spec init resolves the pin it writes, it shall use --specs when given, else the platform version, else spec-engine@1 with a printed note.",
  ],
  [
    "INIT-028",
    "Where a platform is a lone repository, the spec engine shall pin it to the platform version, so it never drifts against its own domains.",
  ],
  [
    "INIT-029",
    "If a domain SPEC.json is malformed, then spec init shall derive the platform version from the remaining domains.",
  ],
  [
    "INIT-034",
    "When spec init runs, it shall pin the target to the nearest enclosing platform that holds a spec-engine/ directory.",
  ],
  [
    "INIT-035",
    "Where a platform is a lone repository with no platform file, the spec engine shall index it as one coverage column, or one per workspace package in a monorepo.",
  ],
  [
    "INIT-038",
    "When spec init targets an undeclared repository in the platform folder, it shall declare the repository as a member before writing its pin.",
  ],
  [
    "INIT-039",
    "When spec init runs with --platform for a member checkout outside the platform folder, it shall record the checkout's location for that user, so the member indexes from there.",
  ],
  [
    "INIT-041",
    "Where a monorepo has files outside every workspace package, the spec engine shall scan those files once as one extra coverage column.",
  ],
  [
    "MAP-003",
    "When spec get runs with a requirement id, it shall print that requirement's full record.",
  ],
  [
    "OWNER-002",
    "When a change flips a requirement to superseded or deprecated without approval from a CODEOWNERS owner of its domain, spec check shall report UNAPPROVED_STATUS_FLIP at warning severity.",
  ],
  [
    "PROOF-009",
    "The spec check command shall read a JUnit XML results file from any test runner without runner-specific configuration.",
  ],
  [
    "PROOF-012",
    "When spec check runs without --results, it shall report PROOFS_UNCONFIRMED at warning severity.",
  ],
  [
    "PROOF-014",
    "When --results names a JUnit XML file, spec check shall mark each verifying tag passing or failing from the outcomes recorded for its file's test cases.",
  ],
  [
    "PROOF-016",
    "While test results are supplied, spec check shall report UNPROVEN_REQ for an Active requirement that has no verifying tag correlated to a passing test.",
  ],
  [
    "PROP-005",
    "When spec propagation runs for a superseded requirement, it shall classify each member repo as migrated to the successor, still on the predecessor, or elsewhere in the domain.",
  ],
  [
    "PROV-005",
    "The spec engine shall treat an issue id as an opaque string, storing and displaying it verbatim.",
  ],
  [
    "QURY-006",
    "When searching requirements, spec query shall exclude superseded and deprecated requirements from the results.",
  ],
  [
    "REQ-021",
    "When spec deprecate runs with a reason on an Active or Draft requirement, it shall mark the entry deprecated with that reason recorded on it.",
  ],
  [
    "REQ-027",
    "If a spec command runs in a directory with no spec-engine/ directory, then it shall print the not-a-platform guidance and exit 2.",
  ],
  ["REQ-028", "Every spec authoring command shall exit with 0 or 2 only, never 1."],
  [
    "REQ-031",
    "When a statement or why holds an @ followed by a relative path containing a slash, the spec engine shall treat it as a file reference resolved from the platform root.",
  ],
  [
    "REQ-036",
    "When spec supersede or spec move reports a version, it shall report the derived domain version after the change.",
  ],
  [
    "REQ-038",
    "If a lifecycle command refuses for any reason, then the spec engine shall leave every SPEC.json unchanged.",
  ],
  [
    "REQ-048",
    "When a lifecycle command targets an id held in a domain other than its prefix, it shall act on the entry where it is held.",
  ],
  [
    "REQ-050",
    "When any authoring surface receives a relates list, the spec engine shall split each value on commas and trim each entry.",
  ],
  [
    "REQ-051",
    "When an amend, supersede, or move receives a relates list, the spec engine shall replace the target's relates with it, an empty list clearing it.",
  ],
  [
    "SCHM-012",
    "When the CLI, the webapp, and the MCP server answer the same query over the same platform, they shall return the same data.",
  ],
  [
    "SCHM-016",
    "When a spec command rewrites a SPEC.json, it shall preserve every envelope and entry field it was not asked to change.",
  ],
  [
    "SCHM-024",
    "When an authoring request arrives through the CLI, the HTTP API, or the MCP server, the spec engine shall write the same envelope and return the same --json shape.",
  ],
  [
    "SCHM-031",
    "When a spec command rewrites a SPEC.json, it shall leave unchanged entries byte-identical and keep the key order the file already uses for changed or appended entries.",
  ],
  [
    "SERV-007",
    "The spec serve command shall serve a feature's nav link, page, and endpoints only when SPEC_FLAGS lists that feature's key.",
  ],
  [
    "SERV-014",
    "When the all=1 query is absent, the Coverage and Requirements pages shall hide Superseded and Deprecated requirements and any domain left empty.",
  ],
];

// @spec CHRT-025 unit
// @spec CHRT-026 unit
// @spec CHRT-027 unit
// @spec CHRT-028 unit
// @spec CHRT-029 unit
// @spec CHRT-030 unit
describe("statement rules against catalog statements", () => {
  test.each(FLAGGED)("%s breaks %s", (_id, rule, statement) => {
    expect(rulesOf(statement)).toContain(rule);
  });

  test.each(REWRITTEN)("%s passes the wording rules", (_id, statement) => {
    expect(rulesOf(statement).filter((rule) => WORDING_RULES.includes(rule))).toEqual([]);
  });
});
