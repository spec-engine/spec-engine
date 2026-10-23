---
title: Agent Reference
description: The model, the authoring standard, and the exact contract of the spec CLI, for coding agents and the people who direct them
---

The reference for a coding agent working in a repository that uses Spec Engine. It has three parts: the model and the working loop, the standard every requirement is written against, and the exact contract of every `spec` command.

## What Spec Engine is

Spec Engine helps developers, product teams, and agents write better specs and keep them current, so the software changes accurately.

It works with four things:

| Noun | What it is | Where it lives | Authored or derived |
| --- | --- | --- | --- |
| Domain | A named subject area of requirements with an UPPERCASE key (`BILLING`), an owner, and a charter that says what belongs in it | `spec-engine/<KEY>/SPEC.json`, one file per domain | Authored |
| Requirement | One durable rule of the product's behavior, addressed by a permanent id `KEY-NNN` (`BILLING-009`), with a statement, a why, and a status | An entry in its domain's `SPEC.json` | Authored |
| Tag | A comment `@spec KEY-NNN` that binds a line of code or a test to a requirement | Source and test files, in comments | Authored in code |
| Index | A SQLite database of every domain, requirement, and tag, which the read and check commands query | `.spec-engine/index.sqlite` at the platform root | Derived |

- The `SPEC.json` files are the only authored truth about what the product promises. Write them through the `spec` commands. An id is never reused or renumbered: a changed promise is superseded by a new id, and an ended one is deprecated.
- Tags in code are the only truth about where a requirement is implemented and where it is verified. A tag in implementation code implements; a tag in a test file verifies. The kind comes from the file path, never from the tag text.
- The index is derived and disposable. Every command rebuilds it from the `SPEC.json` files and the tags, and deleting `.spec-engine/` is always safe.
- Requirements are not tickets. One ticket usually becomes several requirements. A ticket id is provenance only: it goes in `--issue`, never in a requirement id or a tag.

## The loop

```shell
spec query "renewal charge" . --json         # 1. route: requirements on the topic
spec resolve src/billing/renew.ts . --json   #    or the ones tagged in a file
# 2. implement the change
# 3. tag the function that produces the behavior and the test that proves it
spec check . --ci --json                     # 4. exit 1: fix before the PR
spec guard . --json                          # 5. exit 1: the change loses a requirement
```

When `spec guard` blocks, relay its `🛑 spec-guard:` block verbatim to the user. Then either `spec supersede` the requirement with a successor or get the user's explicit decision to `spec deprecate` it. Never delete a requirement to make the gate pass.

## What to tag

```ts
export function renew() { /* … */ }     // @spec BILLING-009
it("charges current price", () => {})   // @spec BILLING-009 unit
```

- A tag binds the one function that produces the behavior and the one test that proves it.
- Helpers, glue code, and configuration carry no tag.
- If you cannot name the behavior a line produces, do not tag it.
- A test tag may end with a level: `unit`, `integration`, or `e2e`.

## In CI

```shell
spec check . --ci --base "$(git merge-base HEAD origin/main)"
```

Without `--base`, `check` diffs against `HEAD`, which in a CI checkout already holds the change, so the removal and loss checks find nothing to report.

## Requirement authoring standard

<!-- @spec CHRT-024 -->

The rules every new requirement is written against. The statement shapes and the statement rules are also checked at write time and by `spec check`.

0. **A requirement is one rule of the product's behavior, stated from the user's point of view.** The statement rules below are the mechanical half of this rule: `spec req`, `amend`, `supersede`, `move`, and `accept` refuse a statement that breaks one, `spec check` reports an Active statement that breaks one as `STATEMENT_RULES`, and `spec lint` lists every finding. The judgment half stays with the author.
1. **One behavior per requirement.** A ticket usually splits into several requirements. Never mint one requirement per ticket.
2. **Write the statement in a fixed shape.** Pick the sentence shape that matches the situation. The word "shall" separates who acts from the observable result:

   | Situation | Shape | Example |
   | --- | --- | --- |
   | Always true | The `<system>` shall `<result>` | The spec CLI shall write JSON output to stdout only. |
   | Triggered by an event | When `<trigger>`, the `<system>` shall `<result>` | When an unknown requirement id is passed, spec resolve shall print `[]` and exit 0. |
   | Only in a certain state | While `<state>`, the `<system>` shall `<result>` | While the index file is missing, read commands shall rebuild it before answering. |
   | Handling something going wrong | If `<failure>`, then the `<system>` shall `<result>` | If the results file cannot be parsed, then spec check shall report the file and exit 2. |
   | Only when a feature is present | Where `<feature>`, the `<system>` shall `<result>` | Where a member config lists ignore directories, the scanner shall skip them. |

   A statement that fits no row has not yet decided what triggers the behavior or what observably happens.

   A statement may end with a trailing `so <observable consequence>` clause ("…shall report NO_SPEC_CONFIG at warning severity, so a lone warning never fails the gate") when the consequence is itself observable. The reason the behavior exists belongs in the why, never in the statement.

   One promise per statement. A result that chains two behaviors with `and`, or that sets two severities, is two requirements: a single test must be able to prove the whole statement. Prefer `When`, `If … then`, and the bare `shall` form. Use `While` and `Where` only when a state or a feature is what gates the behavior.
3. **It must make sense on its own.** A reader who sees only this one statement, in search results or a report, understands it. A statement that says "the normalization" or "that prefix" without naming the subject fails.
4. **Describe what it does, not how.** Say what a user or calling agent observes. If renaming an internal function would make the statement wrong, it is written at the wrong level.
5. **No expiration dates.** No "currently", no "the new behavior", no references to things that were removed.
6. **The why states what breaks.** Answer "what goes wrong if this stops being true". Never restate the requirement in other words.
7. **Three link types, three jobs.** Tests prove it. Code implements it. Tickets are only history: never an id, never proof.
8. **File it where the promise lives, and search first.** Pick the domain whose charter covers the behavior, and run `spec query` before minting. If something close exists, amend it instead.

### Requirement id format

<!-- @spec CHRT-023 -->

- Ids are `KEY-NNN`: the domain key, a hyphen, and a three-digit zero-padded number (`BILLING-010`).
- Ids are permanent. A requirement is superseded or deprecated, never renumbered and never deleted.

### The one-promise lint

A domain envelope may declare `grammar: "ears"` with `grammarSeverity: "warning" | "error"` (default warning). Set both with `spec domain grammar <KEY>`, never by hand. In such a domain a statement must fit one of the five shapes, and a statement that fits a shape still fails when:

| Rule | Fails | Passes |
| --- | --- | --- |
| Semicolon clause | `; ` anywhere after the first `shall` | `When a; b holds, X shall …` |
| Second subject | `, and <subject> shall` after the first `shall` | `X shall A, and shall B` |
| Rationale | `because`, `so that`, `in order to` anywhere | a trailing `, so <observable consequence>` |

- `spec check` reports a nonconforming Active or Draft statement as `STATEMENT_GRAMMAR` at the declared severity, one row per statement, the detail naming the first failed shape or rule.
- `spec req`, `amend`, `supersede`, and `move` judge new text at write time: they warn and write under warning, and refuse (exit 2) under error.
- The lint is a pattern, not a reading: a statement that passes can still chain two behaviors, and the reviewer still owns that call.
- The TERM domain is exempt.

### The statement rules

Every domain is judged by these rules, whatever its grammar. `spec req`, `amend`, `supersede`, `move` (with new text), and `accept` refuse a statement that breaks an enabled rule: exit 2, one `<rule>: <detail> — <reason>` line per finding, rule 0 last. There is no override flag; the `statementRules` block of `check.json` tunes a rule or turns it off. `spec check` reports an Active statement that breaks one as `STATEMENT_RULES`, one row per rule per statement. The TERM domain is never judged.

| Rule | Reports | Printed reason |
| --- | --- | --- |
| `one-sentence` | more than one sentence, no closing period, or a line break | a statement is one testable sentence |
| `length` | over `maxLength` characters (280 by default) | a sentence a reader holds at once |
| `no-file-path` | a repository path or file name | which file holds what is layout, not behaviour |
| `no-test-narration` | how a test is written | how a test is written is not what the product does |
| `no-toolchain-layout` | CI or tooling layout | how CI and tooling are arranged is not a product behaviour |
| `no-history` | how the requirement changed | a statement says what holds now, not how it got there |
| `no-jargon` | a word from the jargon list | a reader without the codebase cannot parse project jargon |
| `no-tool-statement` | which tool is in use | naming the tool in use is a decision record, not a requirement |

## Authoring requirements (brief → mint)

<!-- @spec AUTHOR-013 -->

<!-- @spec AUTHOR-012 -->

The procedure for turning a brief or ticket into requirements. Each draft is written to the requirement authoring standard above.

1. **Split the brief.** One requirement per behavior, never one per ticket.
2. **Place each.** `spec domain list --json` prints every charter. File the requirement where the promise lives.
3. **Dedup.** `spec query "<phrase>" . --json` before minting. Overlap means `spec amend` or relate the existing requirement.
4. **Draft to the standard.** Every draft quotes the phrase of the brief it derives from.
5. **Mint.** `spec req <domain> --text "<statement>" --why "<what breaks>" [--issue <ticket>]`.
6. **Provenance, not identity.** The ticket goes in `--issue`, never in an id or a tag.
7. **Verify.** `spec index . && spec check . --ci` (exit 0) and `spec guard .` before the PR.

## Command reference

### Invocation

```shell
spec <command> [...]                            # after: bun add -g @spec-engine/spec-engine
bunx @spec-engine/spec-engine <command> [...]   # without a global install (requires Bun)
```

- Almost every command takes an optional trailing `platformDir` positional (default: cwd). The platform dir is the directory that contains `spec-engine/`.
- Every command is non-interactive when stdin is not a TTY.
- `--json` goes to **stdout only**. Guidance, warnings, and diagnostics chrome go to **stderr**. Parse stdout, surface stderr.

### Platforms, members, and pins

- A platform is the directory holding `spec-engine/`. When declared, its platform file `platform-map.json` is `{ name, members, ignore }`.
- A member is a repository named in that file, carrying a `{ platform, member }` marker. A monorepo's coverage columns are its workspace packages, named by path (`packages/engine`). A lone repository with no platform file is one column or its packages. A monorepo's files outside every package are one more column, named by the member or, for a lone monorepo, the directory.
- `spec-engine.member.json` adds one fact: the member's pin, `spec-engine@N`. `spec init <name>` declares and pins in one step.
- A requirement domain's version is derived from its supersede history. The platform version is the max domain version. Drift compares a member's pin against each referenced requirement's `changed_at_version`. A stray `spec-engine.platform.json` is ignored with a warning.
- A member's `dependsOn` (the platform's own package names in its manifest) orders `spec propagation`: providers before consumers.

### Tags

- The tag is `@spec KEY-NNN`, optionally followed by a level token `unit` | `integration` | `e2e` on a test tag. Never write "implements" or "verifies" in the tag.
- The scanner reads `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.sh`, `.lua`, `.luau`, `.go`, `.rs`, `.tf`, `.toml`, `.sql`, `.css`, `.yml`, `.yaml`, and `.astro` files, any file named `Dockerfile` or `Dockerfile.<suffix>`, and `.md` documents, whose tags document.
- The tag regex ignores the comment leader, so `--`, `//`, `#`, `<!-- -->`, and `/* … */` all work.
- Dot-prefixed directories are skipped except `.github/`. `fixtures/` directories are ignored everywhere.
- A tag in implementation code implements; a tag in a test path verifies. A test path contains `.test.`, `.spec.`, `__tests__/`, `/tests/`, `/e2e/`, or `.e2e.`, or ends in `_test.go`, `_test.rs`, `_spec.lua`, or `_test.lua`, or lives under `spec/` (busted).
- Rust tests inline under `#[cfg(test)]` sit in the implementation file and count as implements; put a verifying tag in `tests/` or a `*_test.rs` file.

### Exit code contract

| Code | Meaning |
| --- | --- |
| 0 | Success. Empty results are success (`[]` on stdout, guidance on stderr). |
| 1 | Data-level failure: `check` found an error-severity diagnostic; `guard` found a loss; `gate` failed; `index` crashed mid-build. |
| 2 | Usage/environment error: bad args, not a Spec Engine platform (no `spec-engine/`), path-containment violation, invalid `--limit`/`--port`, FTS5 syntax error. |

Branch on exit codes, not on output text.

### Commands

| Command | Synopsis | `--json` | Exits |
| --- | --- | --- | --- |
| `spec index [platformDir]` | Build or refresh the derived index | yes (IndexResult) | 0 / 1 / 2 |
| `spec check [platformDir] [--ci]` | Integrity + coverage + drift diagnostics | yes (array) | 0 / 1 / 2 |
| `spec guard [platformDir] [--against <ref>]` | Block a change about to lose a requirement, its last implementation, or its last test | yes (array) | 0 / 1 / 2 |
| `spec map [platformDir]` | Requirement × repo coverage matrix | yes (array) | 0 / 2 |
| `spec get <KEY-NNN> [platformDir]` | One requirement's full record and its tag sites; unknown id is `[]` | yes (object, or `[]`) | 0 / 2 |
| `spec list [platformDir] [--domain KEY] [--status S]` | Every requirement record in (key, seq) order, history included | yes (array) | 0 / 2 |
| `spec query <text> [platformDir]` | Full-text retrieval over requirements | yes (array) | 0 / 2 |
| `spec relations [platformDir]` | Mermaid graph of `relates` links | yes (array) | 0 / 2 |
| `spec provenance [issueId] [platformDir]` | Per-requirement provenance matrix | yes (array) | 0 / 2 |
| `spec resolve <files…> [platformDir]` | Requirements tagged in the given files | yes (array) | 0 / 2 |
| `spec propagation <KEY-NNN> [platformDir]` | Per-repo migrated/drifted state for a superseded requirement | yes (array) | 0 / 2 |
| `spec gate <repo> <KEY-NNN> [platformDir]` | Approval gate: pass iff Active and the pin covers it | yes (object) | 0 / 1 / 2 |
| `spec init [repo]` | Declare a member through platform-map and write its `spec-engine.member.json` pin | yes (object) | 0 / 2 |
| `spec domain new <KEY>` / `spec domain list` / `spec domain grammar <KEY>` | Scaffold / list `spec-engine/<KEY>/SPEC.json` / set its statement grammar and severity | `list`: yes (array); `grammar`: yes (object) | 0 / 2 |
| `spec migrate [platformDir]` | Strip the retired `livesIn` and `verifiedIn` fields from every `SPEC.json` (idempotent) | yes (object) | 0 / 2 |
| `spec req <domain-prefix> [platformDir]` | Piped: next unused id. `--text`: author non-interactively | yes (object) | 0 / 2 |
| `spec term …` | Author, list, revise, and confirm glossary terms | yes | 0 / 2 |
| `spec glossary [platformDir]` | Generate `GLOSSARY.md` from the TERM store; `--migrate`, `--check` | yes (object) | 0 / 1 / 2 |
| `spec deprecate <KEY-NNN> --reason "…" [platformDir]` | End an Active/Draft requirement with a recorded reason | yes (object) | 0 / 2 |
| `spec supersede <KEY-NNN> [platformDir]` | Flip to superseded, mint the successor, emit the retag worklist | yes (object) | 0 / 2 |
| `spec move <KEY-NNN> <NEW-DOMAIN> [platformDir]` | Cross-domain supersede | yes (object) | 0 / 2 |
| `spec amend <KEY-NNN> [platformDir]` | Revise an unshipped entry in place | yes (object) | 0 / 2 |
| `spec accept <KEY-NNN> [platformDir]` | Promote a Draft requirement to Active | yes (object) | 0 / 2 |
| `spec lint [KEY \| KEY-NNN] [platformDir] [--all]` | Every statement-rule finding for the platform, a domain, or a requirement | yes (array) | 0 / 1 / 2 |
| `spec serve [platformDir] [--port N] [--host IP]` | Local webapp + `/api/*` over the index | n/a (HTTP) | 0 / 1 / 2 |
| `spec docs [--port N]` | Serve the bundled docs site offline | n/a (HTTP) | 0 / 1 / 2 |
| `spec mcp [platformDir]` | MCP server over stdio | n/a (JSON-RPC) | 0 / 2 |

Common flags on the index-touching commands (`index`, `check`, `map`, `get`, `list`, `query`, `relations`, `resolve`, `propagation`, `provenance`, `gate`, `serve`):

| Flag | Effect |
| --- | --- |
| `--out <path>` | Index DB path override. Must resolve inside `platformDir` (exit 2 otherwise). |
| `--no-prompt` | Suppress the member-onboarding prompt. |
| `--json` | Machine output (all except `serve`). |
| `--fresh` | Read commands only: delete the DB plus WAL/SHM and reindex before answering. |

`init`, `domain list`, `req` register `--json` only. `domain new` registers none.

**Index freshness.** Read commands (`map`, `get`, `list`, `query`, `relations`, `resolve`, `propagation`, `provenance`) build the index when it is missing and otherwise trust it. A warm index older than a changed `SPEC.json` produces a stderr warning. Tag-only code edits are not detected. `gate` always rebuilds cold, and so does `check --ci`. After editing specs or tags, pass `--fresh`.

### spec index

Build or refresh the derived index.

`--json`: `{ build_id, repos, domains, requirements, tags, diagnostics }`.

Exit: 0 built / 1 an invalid SPEC.json refused the build, or the build crashed / 2 not a platform or bad args.

- `build_id` is deterministic for identical inputs (cold-rebuild equivalence).
- A `SPEC.json` that is not JSON or fails the shared schema refuses the whole build, and the index on disk is left as it was. Every file is parsed first, so one run reports every invalid file. Under `--json` stdout holds only the `INVALID_DOMAIN_FILE` rows in the `spec check --json` row shape; text mode prints only those rows on stderr. Every other index-building command prints only the same rows and exits 1 (`check`, `gate`, `guard`, `serve`, and the read commands); a lifecycle command that reindexes for its worklist (`supersede`, `amend`, `deprecate`, `move`, `term confirm`) exits 2 after its write.
- Also writes `.spec-engine/doctor.md`, a list of doc lines that mention a requirement id without an explicit `<!-- @spec ID -->` binding.

### spec check

Integrity, coverage, drift, and governance diagnostics.

| Flag | Effect |
| --- | --- |
| `--ci` | Delete the DB first. Correctness never trusts a warm index. |
| `--results <junit.xml>` | The trusted-red gate: a verifying tag counts only when its test passed. Path resolves inside `platformDir`. |
| `--base <ref>` | Diff the requirement set against a git ref (deletion and status-flip governance). |
| `--approved-by <list>` | Approver set for the status-flip check. |
| `--require-owner-approval` | Escalate `UNAPPROVED_STATUS_FLIP` from warning to error. |
| `--unsourced-change` | Also warn on superseded requirements with no `supersedes-via` issue. |

`--json` rows: `{ code, severity, repo, source_file, line, req_id, detail }`, nullable except `code`, `severity`, `detail`, sorted deterministically.

Exit: 0 clean or warnings only / 1 any error-severity row / 2 usage.

<!-- @spec CHCK-053 -->

Codes, in `DiagnosticCode` order:

| Code | Severity | Condition |
| --- | --- | --- |
| `DUP_ID` | error | The same requirement id appears twice |
| `BROKEN_SUPERSEDE` | error | A `supersededBy` names a missing id, or a `supersedes` names a missing id or the entry itself |
| `BAD_STATUS` | error | An entry status outside `active` / `draft` / `superseded` / `deprecated` |
| `DANGLING_TAG` | error | A tag references no requirement |
| `SUPERSEDED_REFERENCED` | error | Code still tags a superseded requirement (retag to the successor) |
| `DEPRECATED_REFERENCED` | error | Code still tags a deprecated requirement |
| `STATEMENT_GRAMMAR` | per domain, default warning | A statement fails its domain's declared grammar |
| `STATEMENT_RULES` | warning; per rule from `statementRules.severity` | An Active statement breaks a statement rule: one row per rule per statement, the detail `<rule>: <detail> — <reason>` |
| `DRAFT_REFERENCED` | error on a verifying tag, warning on an implementing or documenting tag | A tag references a Draft requirement |
| `GLOSSARY_DRIFT` | warning | The committed glossary differs from the one generated from the term store |
| `ORPHAN_REQ` | error | An Active requirement has no implementing tag |
| `UNVERIFIED_REQ` | warning | An Active requirement is implemented but has no verifying tag |
| `DRIFT` | error | A member is pinned behind the version at which a requirement it references changed |
| `NO_SPEC_CONFIG` | warning | A declared member is present on disk with no `spec-engine.member.json` |
| `BROKEN_RELATES` | warning | A `relates` entry names a nonexistent requirement |
| `RELATES_SUPERSEDED` | warning | A `relates` entry names a superseded requirement |
| `CYCLIC_SUPERSEDE` | error | A circular supersession chain |
| `SELF_RELATES` | warning | A `relates` entry names its own requirement (dropped, but surfaced) |
| `UNKNOWN_ROLE` | warning | An `issues` entry uses a role outside `created` / `supersedes-via` / `amends-via` (surfaced and dropped, never stored) |
| `UNSOURCED_CHANGE` | warning, only with `--unsourced-change` | A superseded requirement carries no `supersedes-via` issue |
| `INVALID_DOMAIN_FILE` | error | A `SPEC.json` is not JSON or fails the shared schema; one row per failing field |
| `UNPROVEN_REQ` | error, only with `--results` | An Active requirement has verifying tags but no passing correlated test |
| `PROOFS_UNCONFIRMED` | warning, only without `--results` | The proof gate fell back to presence-only mode |
| `REQUIREMENT_REMOVED` | error | An Active requirement present at the base ref is gone with no same-change supersession |
| `IMPL_LOST` | error, when a base ref resolves | The change removes the last implementing tag of a surviving Active requirement |
| `VERIFY_LOST` | warning, when a base ref resolves | The change removes the last verifying tag of a surviving Active requirement |
| `SPEC_FILE_DELETED` | error, when a base ref resolves | A `SPEC.json` present at the base ref is gone |
| `UNAPPROVED_STATUS_FLIP` | warning; error with `--require-owner-approval` | A flip to superseded or deprecated whose CODEOWNERS domain owner is absent from `--approved-by` |
| `PARTIAL_PROPAGATION` | error, needs `--base` and `--results` | A changed requirement where some bound tests pass and some fail |
| `MALFORMED_FILE` | platform-map's severity: error, or warning for a manifest | A platform file, a package or workspace manifest, or platform-map's per-user file failed to parse or validate |
| `MEMBER_MISSING` | warning | A declared member is not on this machine; it is not scanned |
| `MARKER_MISSING` | warning | A declared member has no marker |
| `MARKER_MISMATCH` | error | A member's marker names a different platform |
| `UNLISTED_REPO` | warning (platform-map info, promoted) | A repository in the platform folder is not a member; its tags are not scanned |
| `PLATFORM_NOT_LOCATED` | warning | A marker names a platform this machine cannot find |
| `UNDECLARED_PLATFORM` | warning (platform-map info, promoted) | A folder of repositories with no platform file; nothing in it is a member |
| `SCAN_TRUNCATED` | warning | A workspace walk hit its depth or entry cap |
| `UNDEFINED_TERM` | error | A `cites` entry resolves to no glossary term |
| `ORPHAN_TERM` | warning | An Active term that nothing cites |
| `TERM_DRIFT` | warning | A citation's pin is behind the term's current version |
| `SUPERSEDED_TERM_REFERENCED` | error | A citation names a superseded term |

The four TERM codes are the last four rows. Only `error` rows drive exit 1.

The eight codes before them are platform-map's, surfaced with the platform-map code: every platform-map error and warning keeps its severity; `UNLISTED_REPO` and `UNDECLARED_PLATFORM` are promoted from info to warning because they mean a repository's tags are not scanned; `UNMATCHED_PATTERN` and `AMBIGUOUS_ECOSYSTEM` are not surfaced. `repo` is the diagnostic's subject when it names a member; `source_file` is the subject. `NO_SPEC_CONFIG` stays Spec Engine's own code: a declared member present on disk with no `spec-engine.member.json`.

- Deletion detection runs by default: with no `--base`, the working tree is diffed against `HEAD` whenever git resolves. An Active requirement absent from the tree without a same-change supersession is `REQUIREMENT_REMOVED`. History (superseded and deprecated entries) may never be deleted. Outside git the check stays quiet.
- Without `--results`, `check` emits `PROOFS_UNCONFIRMED` and skips proof enforcement. The results file is never hashed into `build_id`. Generate it with the test runner's JUnit reporter, for example `bun test --reporter=junit --reporter-outfile=.spec-engine/results.xml`.
- Term citations: `UNDEFINED_TERM`, `SUPERSEDED_TERM_REFERENCED`, and `TERM_DRIFT` clear with `spec term confirm`.
- Losses: whenever a base ref resolves (`--base`, else `HEAD`), `check` reports the `IMPL_LOST`, `VERIFY_LOST`, and `SPEC_FILE_DELETED` rows `spec guard` would report against that ref. Guard's `REQUIREMENT_REMOVED` rows are dropped; the removal check already reports that id.
- Under `--ci` with no `--base`, a working tree whose tracked files equal `HEAD` makes every loss check pass vacuously, so `check` warns on stderr with the line to run instead: `spec check . --ci --base "$(git merge-base HEAD origin/<default>)"`. The exit code and stdout are unchanged. <!-- @spec GUARD-031 -->
- Coverage counts only Active requirements: `ORPHAN_REQ` and `UNVERIFIED_REQ` fire for Active entries only. <!-- @spec CHCK-032 -->

#### check.json

`spec-engine/check.json` regrades diagnostics. Absent means no rules.

```json
{ "severity": [
  { "code": "UNVERIFIED_REQ", "severity": "error" },
  { "code": "UNVERIFIED_REQ", "severity": "warning", "match": ["LEGACY", "BILLING-004"] }
] }
```

- `code` is any diagnostic code; `severity` is `error`, `warning`, or `off`.
- `match` lists domain keys and requirement ids. A scoped rule applies only to rows whose `req_id` is listed or carries a listed key.
- The most specific rule wins: an id match, then a domain match, then an unscoped rule. Among equals, the later rule wins.
- `off` drops the row from every output.
- Grading runs inside the operation, so the CLI, `spec_check`, and every other surface agree, and exit 1 follows the graded severities.
- A file that fails the schema (unknown code or key, a bad severity, a malformed match entry) exits 2 with `spec-engine/check.json: <path>: <reason>`.

`statementRules` configures the statement rules on every surface: the write-time refusal, `STATEMENT_RULES`, and `spec lint`.

```json
{ "severity": [],
  "statementRules": {
    "maxLength": 280,
    "jargon": ["seam", "rung"],
    "exemptNames": ["SPEC.json", "spec-engine/"],
    "severity": { "no-jargon": "off", "length": "error" }
} }
```

- `maxLength` defaults to 280. `jargon` replaces the default list (`seam`, `seams`, `rung`, `rungs`, `residue`, `matrix entry`, `stage runner`, `the stage`).
- `exemptNames` are product names `no-file-path` never reports. A name ending in `/` exempts every path under it.
- `severity` maps a rule to `error`, `warning`, or `off`. `off` turns the rule off everywhere. Any other value still refuses a write; it grades the `STATEMENT_RULES` row, and the `severity` array regrades by code after it.
- The rules: `one-sentence`, `length`, `no-file-path`, `no-test-narration`, `no-toolchain-layout`, `no-history`, `no-jargon`, `no-tool-statement`. Unknown keys exit 2.

### spec guard

The pre-commit loss gate. Diffs the requirement derivation at `--against <ref>` (default `HEAD`) against the working tree, scoped to the files in `git diff`. Rebuilds the worktree index cold every run.

`--json` rows: `{ kind, req_id, file, line, detail }`, sorted by `(req_id, kind, file, line)`. `kind` is one of `REQUIREMENT_REMOVED`, `IMPL_LOST`, `VERIFY_LOST`, `SPEC_FILE_DELETED` (`req_id` null).

Exit: 0 clean / 1 any loss / 2 usage.

- A loss is suppressed only by ending the requirement in the same change: supersede it (either direction) or `spec deprecate` it. There is no override comment.
- A non-git tree, a repo with no `HEAD`, or an unknown ref prints `NOT_A_GIT_REPO` to stderr and exits 0.
- A ref that begins with `-` or holds a character outside `A-Z a-z 0-9 . _ / -` is refused before git runs: `guard` treats it as an unknown ref, and `check --base` exits 2.
- Text mode prints a `🛑 spec-guard:` block per requirement, written in the second person. Relay it verbatim to the user before proceeding.

### spec map

`--json` rows keyed `(req_id, repo)`: `{ req_id, domain_key, req_status, req_spec_version, req_changed_at_version, repo, repo_pin, implemented: 0|1, verified: 0|1, test_levels }`. Text mode renders `src`, `test`, `src+test`, `—`.

Exit: 0 / 2.

### spec get

One requirement's full record from the derived index, with the code sites its tags name. Tags are the only record of where a requirement is implemented and verified.

`--json`: the `Requirement` row `{ id, key, seq, status, superseded_by, text, why, source_file, line, spec_version, changed_at_version, superseded_at_version }` plus `implemented_in: [{ repo, file, line, kind }]` (implementing and documenting tags) and `verified_in: [{ repo, file, line, level }]` (verifying tags), each sorted by (repo, file, line). The same object is served by `GET /api/requirements/:id` and `spec_get`, and shown on the webapp `/requirements/:id` page. Text mode is a one-row table (`ID STATUS KEY SEQ CHANGED_AT TEXT`) followed by an `implemented in:` and a `verified in:` list of `file:line`.

Exit: 0 / 2. An unknown id prints `[]` on stdout, guidance on stderr, and exits 0. A malformed id exits 2.

### spec list

Every requirement record in (key, seq) order. Unlike `query`, superseded and deprecated rows are included and nothing is ranked.

| Flag | Effect |
| --- | --- |
| `--domain KEY` | Only that domain (case-insensitive key). |
| `--status S` | Only that status: `active`, `draft`, `superseded`, `deprecated`. Any other word exits 2. |

`--json`: an array of `Requirement` rows, the same rows `GET /api/requirements` serves. Text mode is the `ID STATUS KEY SEQ CHANGED_AT TEXT` table.

Exit: 0 / 2. An empty result is `[]` under `--json`, guidance on stderr in text mode, exit 0.

### spec query

FTS5 `MATCH` syntax. `--limit N` (default 10, max 1000).

Exit: 0 / 2 (bare `AND` or `OR` is an FTS5 grammar error).

- Wrap multi-word phrases in double quotes inside the shell-quoted arg.
- Results rank ascending (best first). Superseded requirements are excluded.
- Glossary term definitions ride the same index. A matching term appears in a separate Terms group in text mode, discriminated by `key` under `--json`.

### spec relations

Text mode: mermaid `graph LR`, one node per requirement in a `relates` field, one undirected deduped edge per pair. `--json` rows: `{ from_id, to_id, source_file, line }`, sorted by (from, to).

Exit: 0 / 2. Empty graph is `[]` and exit 0.

### spec provenance

Per requirement: the creating issue, the revising issues (`supersedes-via`, `amends-via`), the backing tests, and the `source_file:line` pointer.

| Flag | Effect |
| --- | --- |
| `[issueId]` positional | Display-only reverse filter. Never a join key. |
| `--resolve-issues` | Overlay tracker title/status/URL. Needs `SPEC_TRACKER_TOKEN`; degrades to bare ids without it. |

`--json` rows: `{ req_id, role, issue_id, source_file, line, req_status, implemented, verified, test_levels }`, sorted on the full composite key.

Exit: 0 / 2. Empty matrix is `[]` and exit 0.

### spec resolve

Accepts multiple positionals, comma-split inside one positional, and absolute paths under the platform dir.

| Flag | Effect |
| --- | --- |
| `--req KEY-NNN` | Reverse query: every tag site for that requirement. Takes no file positionals. |

`--json` rows (`--req`): `{ req_id, repo, file, line, kind, level }` sorted by (repo, file, line). `kind` is `implements`, `verifies`, or `documents`.

Exit: 0 / 2. Empty result is `[]` and exit 0. Unknown id under `--req` is `[]`.

Path rules. `tags.file` is platform-relative: `<member>/<path>` for a file inside a declared member or a workspace package, and the bare `<path>` for a file a lone repository owns itself (its directory-named or `root` column). The key never carries the checkout's folder name.

- Multi-repo platform: pass `<repo>/<path>`, e.g. `spec resolve api/src/renew.ts .`
- Single repo: pass the path from the platform root, e.g. `spec resolve src/orders.ts .` or `spec resolve .github/workflows/ci.yml .`
- Absolute paths are normalized against `platformDir`. A path outside it exits 2.

### spec propagation

One row per member repo: `{ repo, state, via_req_id, drifted }`. `state` is one of `MIGRATED_VERIFIED`, `MIGRATED_UNVERIFIED`, `ON_PREDECESSOR`, `ON_OTHER_DOMAIN_REQ`, `NO_DOMAIN_REFERENCE`.

Rows are in dependency order: a member comes after every member it depends on, read from platform-map's `dependsOn` (the platform's own package names in a member's manifest), and members at the same depth come by name. The same order is served by `/api/propagation/:id`, `spec_propagation`, and the webapp's `/propagation/:id` page. A platform with no in-platform dependencies lists members by name.

Exit: 0 / 2.

### spec gate

`--json`: `{ pass, reason, repo, req_id, detail, status, changed_at_version, pinned_spec_version }`. `reason` is one of `PASS`, `NOT_FOUND`, `DRAFT`, `SUPERSEDED`, `DEPRECATED`, `VERSION_PIN`, decided in that order. Pin equality passes.

Exit: 0 pass / 1 fail / 2 unknown repo name or bad args.

### spec init

Declares a member through platform-map and writes `spec-engine.member.json`.

| Flag | Effect |
| --- | --- |
| `--specs spec-engine@N` | Override the pin. |
| `--force` | Rewrite an existing config, preserving `ignore`. Any other key refuses, as does a malformed `ignore`. |
| `--platform <dir>` | The platform root, for a declared member checked out outside the platform folder. Its location is recorded in platform-map's per-user file first. |

`--json`: `{ action: "wrote", path, pin, source, declared, linked, agent_surface }`, `{ action: "already-configured", path, pin, extra_fields, declared, linked, agent_surface }`, or, on a platform directory, `{ action: "surface-only", agent_surface }`. `declared` lists the platform-map files written (the platform file, the marker), empty when the member was already declared; `linked` is the per-user file written under `--platform`, else null; `agent_surface` lists the agent-surface files written or changed, `[]` on a re-run.

Exit: 0 wrote or already configured / 2. Branch on `action`, not the exit code.

- Where the target sits decides what is written:
  - a repository directly under a platform folder (a directory holding `spec-engine/`) that the platform file does not list is declared: a `platform-map.json` platform file entry at the root (the file is created when absent) and a `{ platform, member }` marker in the repository, then the pin. platform-map declares only a directory with a `.git` entry or a `package.json`; a plain folder is refused with exit 2;
  - a declared member only gets the pin (a missing marker is written back);
  - a workspace package of a monorepo gets a nested pin and no declaration; a repository inside a lone monorepo that is not a workspace package is refused;
  - a directory under no platform gets the `spec-engine@1` fallback pin;
  - a platform directory (holding `spec-engine/`) gets the agent surface and no pin.
- Every action then installs the agent surface into the repository (the member; the monorepo root for a workspace package), bundled in the npm package under `dist/agent/`. Hints for anything left alone go to stderr.
  - `AGENTS.md`: the agent reference between `<!-- spec-engine:agent-reference:begin -->` and `<!-- spec-engine:agent-reference:end -->`, appended or created, replaced in place when the markers exist; text outside them is never touched. A `CLAUDE.md` that does not mention `AGENTS.md` gets a hint only.
  - `.claude/skills/req-author/`: written when absent; a differing copy is replaced only under `--force`.
  - `.mcp.json`: a `spec` server entry (`spec mcp <platform>`) merged in; other keys and an existing `spec` entry are kept.
  - `pre-commit`: `spec guard <platform>`, written to `.githooks/` or else `.git/hooks/` when no hook exists there; an existing hook gets a hint.
  - With no platform located, the MCP entry and the hook are skipped.
- The platform root is platform-map's `locate()`: the nearest `platform-map.json` or `.git` boundary, a marker resolved through the parent directory or the per-user file; the parent directory when it holds `spec-engine/`. A `.git` boundary between the target and an outer `spec-engine/` hides that platform.
- Default pin: `--specs`, else the derived platform version, else `spec-engine@1` with a printed note.
- A resolved path with a `spec-engine` segment is refused, except on the engine's own checkout (root package named `@spec-engine/spec-engine`), where only the path below the platform root is judged.
- `ignore: ["dir", …]` excludes repo-relative directory prefixes from that repo's scans: `vendor` hides `vendor/x.ts` but not `src/vendor/x.ts`. A monorepo root column excludes its workspace package paths the same way. A monorepo's columns are its workspace manifest's packages.

### spec domain

`spec domain new <KEY>` scaffolds `spec-engine/<KEY>/SPEC.json`. `spec domain list` prints one key per line; `--json` prints a sorted array of `{ key, scope }` (scope is the charter sentence or null), read from the filesystem.

`spec domain grammar <KEY> [platformDir] [--grammar ears|freeform] [--severity warning|error]` sets the envelope's `grammar` and/or `grammarSeverity` through the validating write path; every other field is written back as read. `--json` prints `{ key, grammar, grammar_severity, file }` (an unset field is null). An unknown domain, neither flag, or a value outside the enums exits 2. CLI only: no MCP tool or HTTP route.

```shell
spec domain grammar CHCK --severity error
```

Exit: 0 / 2.

### spec migrate

Rewrites every `SPEC.json` that still carries the retired `livesIn` or `verifiedIn` fields through the write seam, which drops them. A file without them is not touched, so a second run writes nothing. Until a file is migrated, the fields are read and ignored, and the next write of a file drops them.

`--json`: `{ files }`, the platform-relative paths rewritten.

Exit: 0 / 2.

### spec req

| Mode | Behavior |
| --- | --- |
| stdin not a TTY, no `--text` | Print the bare next unused id (e.g. `BILLING-010`), exit 0. No prompts, no writes. |
| `--json`, no `--text` | Print `{ domain, next_id }`. Same zero-write contract, even on a TTY. |
| `--text "<statement>"` | Append an Active entry with zero prompts. `--why`, `--relates`, `--issue <ticket>` fill the other fields and error without `--text`. `--relates` repeats and comma-separates. |
| `--draft` | Author the entry as Draft (with `--text`, or on a TTY). Off a TTY without `--text` it exits 2. |
| TTY, no flags | Interactive authoring. |

`--json` with `--text`: `{ id, file }`, plus `clauses: { pattern, condition, system, response }` when the statement parses as EARS.

Exit: 0 / 2 (ambiguous prefix, unknown domain, grammar refusal, statement-rule refusal).

- The domain prefix is case-insensitive: `bil` resolves to `BILLING`.
- The resolved domain's charter is echoed to stderr on every authoring path.
- Unresolvable `@<path>` refs warn on stderr and never block.

### spec term

A term is a requirement row in the reserved `TERM` domain: definition in `statement`, headword in `term`, synonyms in `aliases`.

| Form | Effect |
| --- | --- |
| `spec term "<name>" --def "<definition>" [--aliases a,b] [--section s]` | Append a `TERM-NNN`. `--json`: `{ id, file }`. |
| `spec term` with no `--def` | Pure id query, mirrors `spec req`: bare next `TERM` id, or `{ domain, next_id }`. |
| `spec term list` | `id  name  status` per line, or `[{ id, term, status }]`. Reads the filesystem. |
| `spec term revise <TERM-NNN> --def "…"` | Rewrite the definition in place and bump the TERM envelope's `specVersion`. `--no-bump` opts out. `--json`: `{ id, file, spec_version }`. |
| `spec term confirm <KEY-NNN> <TERM-NNN>` | Re-pin a citation to the term's current version (clears `TERM_DRIFT`); re-point to the successor when the term is superseded (clears `SUPERSEDED_TERM_REFERENCED`). `--json`: `{ req_id, term_id, pinned, file }`. |

`spec supersede TERM-NNN` and `spec amend TERM-NNN --term/--aliases` work on term ids as on requirements.

Exit: 0 / 2.

### spec glossary

| Form | Effect |
| --- | --- |
| `spec glossary` | Overwrite `GLOSSARY.md` from the TERM store. Byte-stable: fixed header, terms in id order, `## {section}` once per change, one `- **{term}** — {statement}` bullet each. |
| `--migrate` | One-time parse of an existing `GLOSSARY.md` into `TERM-001..N`. Skips when the TERM domain already has entries. |
| `--check` | Regenerate into a buffer and diff against the committed file. Exit 1 on drift. |

`--json`: `{ generated }`, `{ migrated }`, or `{ ok }`.

Exit: 0 / 1 (`--check` drift) / 2.

### spec deprecate

Marks an Active/Draft requirement `deprecated`, records `--reason` on the entry, and prints the cleanup worklist of tags still bound to the id.

Exit: 0 / 2.

### spec supersede

Requires an Active target. Flips it to `superseded by NEW`, mints the successor in the domain file that holds the target, reindexes fresh, and prints the retag worklist (the sites `check` reports as `SUPERSEDED_REFERENCED` until retagged).

The successor copies the predecessor's `why`, `relates`, `cites`, `aliases`, `term`, and `section` unless a flag overrides the field. Its `issues` hold only the `created` row from `--issue`.

| Flag | Effect |
| --- | --- |
| `--text` | The successor statement. Required when not a TTY. |
| `--why`, `--relates` | Successor fields. Default to copies of the predecessor's. `--relates` repeats or comma-separates and replaces the whole list; an empty value clears it. |
| `--issue <ticket>` | Recorded as `supersedes-via` on the predecessor and `created` on the successor. |
| `--no-bump` | TERM domain only: keep the authored `specVersion`. No-op elsewhere. |

`--json`: `{ old_id, new_id, file, spec_version, retag: [{ req_id, repo, file, line, kind, level }] }`. On a requirement domain `spec_version` is the derived domain version after the supersession, and the same number is stamped as the predecessor's `supersededAtVersion`.

Exit: 0 / 2. All guards run before the first byte is written.

### spec move

Cross-domain supersede. Mints the successor as the next id in `<NEW-DOMAIN>` (which must exist), copies `statement`, `why`, `relates`, `cites`, `aliases`, `term`, and `section` (`--text` and `--why` override), flips the source to superseded with a cross-domain `supersededBy`, and prints the retag worklist. The successor carries no `issues`.

`--json`: `{ old_id, new_id, from_file, to_file, source_spec_version, target_spec_version, retag: [...] }`.

Exit: 0 / 2 (non-Active source, or the target is the source's own domain).

- Both envelopes validate before either is written.
- The source version advances; the target version is unchanged.

### spec amend

Revise an Active or Draft entry in place. Same id, no version change.

| Flag | Effect |
| --- | --- |
| `--text`, `--why`, `--relates` | Field to change. At least one flag is required. Untouched fields stay byte-identical. `--relates` repeats or comma-separates and replaces the whole list (the `--aliases` idiom); an empty value clears it. |
| `--issue <ticket>` | Append `amends-via` provenance. |
| `--term`, `--aliases` | TERM ids only. |

`--json`: `{ id, file, fields_changed }`.

A released requirement is an Active entry present in its domain file at the newest `v*` tag merged into HEAD. Its promise does not change in place: a `--text`, `--why`, `--term`, or `--aliases` amend refuses with exit 2, naming the tag. Two paths stay open: `spec supersede` changes the promise, and an amend of only `--relates` or `--issue` writes in place. With no `v*` tag merged into HEAD, or outside git, every entry is unreleased. A Draft entry always amends.

Exit: 0 / 2 (superseded or deprecated target; a released entry's promise fields).

### spec accept

Promotes a Draft requirement to Active. Every other field stays byte-identical and the domain version does not move. Reword a draft with `spec amend` first; end one with `spec deprecate`.

`--json`: `{ id, file }`.

Exit: 0 / 2 (the target is not Draft: nothing is written).

- A Draft never raises `ORPHAN_REQ` or `UNVERIFIED_REQ` and is not counted in the coverage report. A code tag on one is `DRAFT_REFERENCED` (warning).

### spec lint

Every statement-rule finding. Reads `SPEC.json` directly, not the index.

| Form | Scope |
| --- | --- |
| `spec lint [platformDir]` | the platform |
| `spec lint <KEY> [platformDir]` | one domain |
| `spec lint <KEY-NNN> [platformDir]` | one requirement |
| `--all` | Draft requirements as well as Active ones |

Text mode prints `<id> <rule>: <detail> — <reason>` per finding on stdout, then rule 0 on stderr. `--json` prints a sorted array of `{ req_id, rule, detail, reason, source_file, line }`. The TERM domain is never judged. A lone positional that holds `spec-engine/` is the platform dir. CLI only: no MCP tool or HTTP route.

Exit: 0 clean / 1 any finding / 2 usage, unknown domain or id, or a bad `check.json`.

### spec serve

Binds one address: `127.0.0.1`, or `--host <ip>` (a literal loopback, RFC 1918, or `100.64/10` address only; anything else exits 2). `--port 0` (default) picks a free port. `--probe` boots on loopback, fetches `/`, and exits 0 or 1. The startup line, `/api/platform` (`name`), and every page's title and sidebar name the platform (platform file `name`, else the directory name), never a path; `spec mcp` logs the same name on stderr.

A non-loopback `--host` is LAN mode: stdout prints `http://<ip>:<port>/?token=…`; every request needs that token (the query parameter is exchanged for an `HttpOnly; SameSite=Strict` cookie, then a 302 drops it), else 401. A `Host` other than loopback or the bound address is 403. Read-only unless `--allow-writes`: non-GET requests, `/provenance`, and `/api/provenance?resolve=1` answer 403. `--token` / `SPEC_SERVE_TOKEN` pin the token (≥ 16 of `A-Z a-z 0-9 _ -`); otherwise it is 256 random bits.

When the reindex after a write refuses on an invalid `SPEC.json` elsewhere on the platform, the route answers 422 `{ error: "invalid_domain_file", diagnostics: [...] }`, the rows in the `check --json` shape (the CLI exits 2 with the same rows).

Always-on routes: `/`, `/requirements[/:id]`, `/propagation/:id`, `/api/coverage`, `/api/report`, `/api/repos`, `/api/platform`, `/api/requirements[/:id]`, `/api/propagation/:id`, `/api/resolve?files=…`.

Flag-gated, 404 until enabled. `SPEC_FLAGS` is comma-separated; unknown keys are ignored.

| `SPEC_FLAGS` key | Routes |
| --- | --- |
| `query` | `/query`, `/api/query?q=&limit=` |
| `relations` | `/relations`, `/api/relations[?format=mermaid]` |
| `provenance` | `/provenance`, `/api/provenance[?resolve=1]`, `/api/provenance/by-issue?issue=` |
| `editor` | `/editor`, `POST` and `PUT /api/requirements`, `POST /api/requirements/:id/supersede`, `POST /api/requirements/:id/move`, `POST /api/requirements/:id/deprecate`, `POST /api/requirements/:id/accept` |
| `glossary`, `logs` | Placeholder pages |

Exit: 0 / 1 / 2.

### spec docs

Serves the prebuilt docs site on `127.0.0.1`, fully offline.

- Takes no platform dir. Registers none of `--json`, `--out`, `--no-prompt`.
- The npm artifact ships the site at `dist/docs/`. A source checkout serves `packages/site/dist`; run `bun run build:site` first, else exit 2.
- `--probe` mirrors `serve --probe`.

Exit: 0 / 1 / 2.

### spec mcp

MCP server over stdio. Register it as `{ "command": "spec", "args": ["mcp", "<platformDir>"] }`.

| Tool | Returns |
| --- | --- |
| `spec_query` | FTS hits, the `spec query --json` shape |
| `spec_resolve` | files → requirements |
| `spec_req_tags` | requirement → tag sites |
| `spec_coverage_report` | per-domain rollup `{ domain, active, implemented, verified, orphans, unverified }` |
| `spec_check` | diagnostic rows |
| `spec_propagation` | per-repo migration state |
| `spec_next_id` | `{ domain, next_id }`, nothing written |
| `spec_get` | one `Requirement` row with `implemented_in` and `verified_in`, or `[]` for an unknown id; the `spec get --json` shape |
| `spec_list` | `Requirement` rows in (key, seq) order, `domain` and `status` filters; the `spec list --json` shape |
| `spec_supersede` | `{ old_id, new_id, file, spec_version, retag }`, the `spec supersede --json` shape; optional `why`, `relates`, `issue` arguments |
| `spec_deprecate` | `{ id, file, reason, sites }`, the `spec deprecate --json` shape |
| `spec_accept` | `{ id, file }`, the `spec accept --json` shape |
| `spec_req` | `{ id, file, clauses? }`, the `spec req --text --json` shape; `domain` (key or prefix) and `text` required, optional `why`, `relates`, `issue`, `draft` |
| `spec_amend` | `{ id, file, fields_changed }`, the `spec amend --json` shape; `id` required, optional `text`, `why`, `relates`, `issue` |
| `spec_move` | `{ old_id, new_id, from_file, to_file, source_spec_version, target_spec_version, retag }`, the `spec move --json` shape; `id` and `newDomain` required, optional `text`, `why` |

Every tool call reindexes fresh. stdout is the protocol channel; chrome goes to stderr. One prompt, `author_requirements` (`brief` required, `domain` optional), returns a static authoring playbook with the brief and the domain's charter substituted. The engine runs no model.

Exit: 0 / 2.

### Gotchas

- **`fixtures/` is globally ignored by the tag scanner.** Tags under any `fixtures/` folder are test data, not coverage claims.
- **The index owns nothing.** Never edit `.spec-engine/index.sqlite`. Edit the `SPEC.json` source and re-run `spec index`.
- **`storage_unavailable` / `SQLITE_IOERR*` means your environment.** The index runs in WAL mode and needs real file locks. A sandboxed process gets `SQLITE_IOERR_VNODE`; re-run unsandboxed or grant write and lock access to `<platformDir>/.spec-engine/`. `SQLITE_BUSY` means another `spec` process holds the index.
- **Empty is not an error.** Read commands exit 0 with `[]` and guidance on stderr.
- **Determinism is contractual.** JSON outputs are sorted and byte-stable.
- A directory passed as the last positional is `platformDir` only if it contains `spec-engine/`. Otherwise it is treated as a file, with a warning.
