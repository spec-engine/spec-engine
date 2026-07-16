---
title: Agent Reference
description: Machine-oriented reference for coding agents driving the spec CLI
---

Machine-oriented reference for coding agents. For narrative and rationale, see the other docs sections.

## Mental model

1. Canonical truth: `spec-engine/<DOMAIN>/SPEC.json` files in git, validated by one shared schema on every surface. Requirement IDs (`KEY-NNN`) are permanent; changes supersede, never overwrite.
2. Code binds to requirements with comment tags: `// @spec KEY-NNN` (+ optional level token).
3. Tag kind is path-derived: implementation code = implements; test path = verifies.
4. The index at `<platformDir>/.spec-engine/index.sqlite` is derived and disposable — read commands build it transparently when missing.
5. Coverage/drift/propagation are SQL projections over tags — never authored. Drift compares a member's pin (`spec-engine@N`, one platform-wide scalar) against each referenced requirement's `changed_at_version`, derived within its domain's supersede DAG; the platform version is the max domain version, derived too.

## Invocation

```shell
bun packages/engine/src/cli.ts <command> [...]   # from a checkout
./dist/spec <command> [...]                     # compiled binary
```

- Almost every command takes an optional trailing `platformDir` positional (default: cwd)
- All commands are non-interactive when stdin is not a TTY
- `--json` output → **stdout only**; guidance, warnings, diagnostics → **stderr**

## The agent loop

### Route — before changing code

```shell
spec query "renewal charge" . --json
spec resolve src/billing/renew.ts . --json
```

### Tag — while implementing

```ts
export function renew() { /* … */ }     // @spec BILLING-009
it("charges current price", () => {})   // @spec BILLING-009 unit
```

### Check — before finishing

```shell
echo | spec req bil                    # next unused BILLING id
spec index . --json
spec check . --ci --json               # exit 1 → fix before PR
spec guard . --json                    # exit 1 → this change deletes a live requirement
```

## Path rules for `spec resolve`

- **Multi-repo platform:** pass `<repo>/<path>` — e.g., `spec resolve api/src/renew.ts .`
- **Single-repo (rung-1):** both repo-relative (`src/orders.ts`) and basename-prefixed forms accepted
- Absolute paths normalized against `platformDir`; paths outside it exit 2

## Gotchas

- **`fixtures/` is globally ignored** by the tag scanner — planted fixture tags are test data, not coverage claims
- **The DB owns nothing** — never edit `.spec-engine/index.sqlite`; edit the SPEC.json source and re-run `spec index`
- **Empty ≠ error** — read commands exit 0 with `[]` on stdout and guidance on stderr
- **Determinism is contractual** — JSON outputs are deterministically sorted, byte-stable across runs
