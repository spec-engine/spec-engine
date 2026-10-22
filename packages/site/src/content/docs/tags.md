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

## Scanned files

Code is read from any file named `Dockerfile` or `Dockerfile.<suffix>` and from these extensions:

- `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`
- `.sh`
- `.lua`, `.luau`
- `.go`
- `.rs`
- `.tf`
- `.toml`
- `.sql`
- `.css`
- `.yml`, `.yaml`
- `.astro`

Documentation is read from `.md` files.

The tag regex ignores the comment leader, so each of these binds:

| Leader | Where |
| --- | --- |
| `// @spec BILLING-009` | TypeScript, JavaScript, Go, Rust, Astro front-matter |
| `# @spec BILLING-009` | shell, Terraform, TOML, YAML, Dockerfile |
| `-- @spec BILLING-009` | Lua, Luau, SQL |
| `/* @spec BILLING-009 */` | CSS |
| an HTML comment | Astro template, Markdown |

Dot-prefixed directories are skipped, except `.github/`.

## Tag kind

Kind is **path-derived**, never authored:

| Location | Kind |
| --- | --- |
| `src/` or similar implementation path | **implements** |
| `test/` or similar test path | **verifies** |
| a docs path (e.g. `docs/*.md`) | **documents** |

A path is a test path when it contains one of these:

| Convention | Substring | Example |
| --- | --- | --- |
| TypeScript and JavaScript runners | `.test.`, `.spec.`, `__tests__/`, `/tests/`, `/e2e/`, `.e2e.` | `test/renew.test.ts`, `src/renew.spec.ts` |
| Go | `_test.go` | `renew_test.go` |
| Rust | `/tests/`, `_test.rs` | `tests/renew.rs`, `src/renew_test.rs` |
| Lua with busted | `_spec.lua`, `_test.lua`, `/spec/` | `spec/renew_spec.lua` |
| Luau with TestEZ or Jest-Lua | `.spec.`, `.test.` | `renew.spec.luau`, `renew.test.luau` |

Rust unit tests written inline under `#[cfg(test)]` live in the implementation file, so a tag there counts as **implements**; a verifying tag belongs in a `tests/` integration test or a `*_test.rs` file. A path rule cannot see inside a file, and Spec Engine does not read attributes.

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
