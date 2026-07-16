---
title: Integrity Checks
description: Diagnostic codes and what they mean
---

`spec check` runs cross-repo integrity, coverage, and drift diagnostics. Error-severity diagnostics drive exit 1; warnings alone exit 0. `--ci` forces a cold rebuild (deletes the DB first — correctness never trusts a warm index).

## Always-on diagnostics

| Code | Severity | Condition |
| --- | --- | --- |
| `INVALID_DOMAIN_FILE` | error | A `SPEC.json` fails the structural schema (bad JSON, malformed `key`/`id`, missing `statement`, unknown envelope key) — loud, never a silent zero |
| `DUP_ID` | error | The same requirement ID appears twice |
| `BROKEN_SUPERSEDE` | error | `supersededBy` points at a missing ID |
| `CYCLIC_SUPERSEDE` | error | A circular supersession chain (`A → B → A`) — the chain is the change history, so a cycle is corrupt history |
| `BAD_STATUS` | error | Entry status outside `active` / `draft` / `superseded` / `retired` |
| `DANGLING_TAG` | error | A `@spec` tag references no requirement |
| `SUPERSEDED_REFERENCED` | error | Code still tags a superseded requirement (retag to the successor) |
| `ORPHAN_REQ` | error | An active requirement has no implementing `@spec` tag |
| `UNVERIFIED_REQ` | error | An active requirement is implemented but has no verifying test tag |
| `DRIFT` | error | A member is pinned behind the version at which a requirement it references changed |
| `NO_SPEC_CONFIG` | warning | A sibling repo-root under the platform has no `spec-engine.member.json` |
| `BROKEN_FILE_REF` | warning | An `@<path>` reference in requirement text does not resolve |
| `BROKEN_RELATES` | warning | A `relates` entry points at a nonexistent requirement ID |
| `RELATES_SUPERSEDED` | warning | A `relates` entry points at a superseded requirement |
| `SELF_RELATES` | warning | A `relates` entry names its own requirement (dropped, but surfaced) |
| `UNKNOWN_ROLE` | warning | An `issues` entry uses a role outside `created` / `supersedes-via` / `amends-via` — surfaced and dropped, never stored |

## Glossary (TERM) diagnostics

| Code | Severity | Condition |
| --- | --- | --- |
| `UNDEFINED_TERM` | error | A requirement's `cites` entry resolves to no glossary TERM |
| `SUPERSEDED_TERM_REFERENCED` | error | A citation points at a superseded term ID — re-point with `spec term confirm` |
| `TERM_DRIFT` | warning | A citation's pin lags the cited term's current version after `spec term revise` — a re-confirmation prompt, not a build-breaker |
| `ORPHAN_TERM` | warning | An active TERM no requirement cites — glossary rot, deliberately non-fatal |

## Trusted-red proof gate (`--results <junit.xml>`)

Pass your test runner's JUnit XML and `check` enforces **proof of passing** — a verifying tag only counts when its test actually passed:

| Code | Severity | Condition |
| --- | --- | --- |
| `UNPROVEN_REQ` | error | An active requirement has verifying tags but no *passing* correlated test |
| `PROOFS_UNCONFIRMED` | warning | No `--results` supplied — the gate falls back to presence-only mode (this warning is the reminder; routed to stderr under `--json`) |

```shell
bun test --reporter=junit --reporter-outfile=.spec-engine/results.xml
spec check . --ci --results .spec-engine/results.xml
```

## Governance diagnostics (`--base <ref>`)

With a git base ref, `check` also diffs the requirement set against that ref:

| Code | Severity | Condition |
| --- | --- | --- |
| `REQUIREMENT_REMOVED` | error | A requirement present at the base ref is gone with no approved supersession |
| `UNAPPROVED_STATUS_FLIP` | warning† | A flip to superseded/retired whose CODEOWNERS domain owner is absent from `--approved-by` — †error under `--require-owner-approval` |
| `PARTIAL_PROPAGATION` | error | Needs `--base` **and** `--results`: a changed requirement where some bound tests pass and some fail — one site migrated, another still red |

See also `spec guard`, the pre-commit loss gate that reports `REQUIREMENT_REMOVED` / `IMPL_LOST` / `VERIFY_LOST` / `SPEC_FILE_DELETED` against the working tree — [Commands](/commands/#spec-guard-platformdir).

## Opt-in policy diagnostics

| Code | Severity | Condition |
| --- | --- | --- |
| `UNSOURCED_CHANGE` | warning | A superseded requirement carries no `supersedes-via` issue. Emitted only under `spec check --unsourced-change` |
