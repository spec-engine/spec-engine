---
title: Tags
description: How code binds to requirements with @spec tags
---

A tag in implementation code **implements** a requirement; a tag in a test file **verifies** it, optionally at a level.

```ts
export function renew() { /* ... */ }    // @spec BILLING-009
it("charges at current price", () => {}) // @spec BILLING-009 unit
it("renews end to end", () => {})        // @spec BILLING-009 e2e
```

## Which files and paths

The scanner reads common source extensions, Dockerfiles, and Markdown documents, and ignores the comment leader, so `//`, `#`, `--`, `/* */`, and an HTML comment all bind. A path is a test path when it follows a test-runner convention such as `.test.`, `__tests__/`, or `_test.go`. The exact extension list and test-path patterns are in the [Agent Reference](/agent-reference/#tags).

| Location | Kind |
| --- | --- |
| implementation code | **implements** |
| a test path | **verifies** |
| a Markdown document | **documents** |

Rust unit tests written inline under `#[cfg(test)]` live in the implementation file, so a tag there counts as **implements**; a verifying tag belongs in a `tests/` integration test or a `*_test.rs` file.

## What to tag

A tag binds the one function that produces the behavior and the one test that proves it. Helpers, glue code, and configuration carry no tag. If you cannot name the behavior a line produces, do not tag it.

## Verification levels

On test tags, an optional level token can be appended:

- `unit` — unit test
- `integration` — integration test
- `e2e` — end-to-end test

## Coverage

`spec map` derives the coverage matrix from tags. It is never authored, only projected (a SQL view over the index), so it cannot drift from the tests it describes.

## Tag scanner notes

- `fixtures/` directories are globally ignored — tags under any `fixtures/` folder never index
- Test files that compose tag strings at runtime should not contain literal `@spec` tags
