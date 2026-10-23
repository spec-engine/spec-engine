---
title: Integrity Checks
description: What spec check reports and how to run it in CI
---

`spec check` reads every `SPEC.json` and every tag on the platform and reports what does not hold together: a tag on a requirement that no longer exists, a requirement nothing implements or tests, a member pinned behind a change, a change that deletes a promise. Error-severity diagnostics exit 1; warnings alone exit 0.

Every code, its severity, and its condition is in the [Agent Reference](/agent-reference/#spec-check), which is the one copy of that list. This page explains the groups and how to run them.

## In CI

```shell
spec check . --ci --base "$(git merge-base HEAD origin/main)"
```

`--ci` deletes the index first, so the result never depends on a warm index. `--base` diffs the requirement set against the point the branch left `main`. Without it, `check` diffs against `HEAD`, which in a CI checkout already holds the change, so the removal and loss checks have nothing to report.

## Integrity and coverage

Always on. A duplicate id, a broken or cyclic supersede chain, a tag that names no requirement or a superseded or deprecated one, an Active requirement with no implementing tag (`ORPHAN_REQ`) or no verifying tag (`UNVERIFIED_REQ`), and a member pinned behind a changed requirement (`DRIFT`). Coverage counts only Active requirements: a draft never raises `ORPHAN_REQ` or `UNVERIFIED_REQ`. <!-- @spec CHCK-032 -->

## Proof of passing (`--results`)

By default a verifying tag counts when it exists. Pass the test runner's JUnit XML and a verifying tag counts only when its test passed; a requirement with no passing test is `UNPROVEN_REQ`.

```shell
bun test --reporter=junit --reporter-outfile=.spec-engine/results.xml
spec check . --ci --results .spec-engine/results.xml
```

## Governance (`--base`)

Against a git ref, `check` reports an Active requirement deleted without a supersession (`REQUIREMENT_REMOVED`), the last implementing or verifying tag of a surviving requirement removed (`IMPL_LOST`, `VERIFY_LOST`), a deleted `SPEC.json`, and a status flip the domain owner did not approve. These are the same losses [`spec guard`](/agent-reference/#spec-guard) blocks before a commit.

## Platform and glossary

Codes from platform-map report a member missing, unlisted, or mismarked, so its tags are not scanned. The glossary codes report a requirement citing an undefined, superseded, or revised term, and an Active term nothing cites.

## Statement rules

`STATEMENT_RULES` reports an Active statement that breaks one of the statement rules in the [requirement authoring standard](/agent-reference/#the-statement-rules). `spec lint` lists the same findings without building the index.

## Regrading (`spec-engine/check.json`)

`check.json` raises, lowers, or turns off a code, for the whole platform or for named domains and requirements, and tunes the statement rules. Its schema is in the [Agent Reference](/agent-reference/#checkjson).
