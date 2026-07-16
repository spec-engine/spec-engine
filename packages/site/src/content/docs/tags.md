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

## Tag kind

Kind is **path-derived**, never authored:

| Location | Kind |
| --- | --- |
| `src/` or similar implementation path | **implements** |
| `test/` or similar test path | **verifies** |
| a docs path (e.g. `docs/*.md`) | **documents** |

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
