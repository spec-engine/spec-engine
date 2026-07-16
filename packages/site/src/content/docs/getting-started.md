---
title: Getting Started
description: Set up and run spec-check in under a minute
---

This is a PoC, so there is no global `spec` install. Run the CLI from a checkout as `bun packages/engine/src/cli.ts <args>`, or build the compiled binary once and run `./dist/spec <args>`.

## See it work in ~10 seconds

The repo ships a `fixtures/platform-fixture` with a canonical `spec-engine/` and three member repos. Render its coverage matrix:

```shell
$ spec map fixtures/platform-fixture
DOMAIN   REQUIREMENT  STATUS      admin     api       mobile  spec-engine
AUTH     AUTH-001     Active      —         —         —       —
BILLING  BILLING-001  Superseded  —         —         src     —
BILLING  BILLING-002  Active      —         src       —       —
BILLING  BILLING-007  Active      src+test  src+test  src     —
BILLING  BILLING-009  Active      —         src+test  —       —
```

Each cell is `src` (implemented), `test` (verified), `src+test` (both), or `—` (no coverage).

## Single repo (rung 1)

The bottom rung: one repo, specs inline, zero ceremony. A repo with an in-repo `spec-engine/<DOMAIN>/SPEC.json` and a `@spec` tag in its own code self-consumes:

```
fixtures/single-repo-fixture/
  spec-engine/
    ORDERS/SPEC.json          ORDERS-001 / ORDERS-002 / ORDERS-003 (active)
  src/
    orders.ts                 // @spec ORDERS-001   // @spec ORDERS-002
  test/
    orders.test.ts            // @spec ORDERS-001 unit
```

```shell
$ spec index fixtures/single-repo-fixture
$ spec map fixtures/single-repo-fixture
$ spec check fixtures/single-repo-fixture
```

**Promote to multi-repo** when you outgrow one repo: `git mv spec-engine/ ../spec-engine` lifts the inline specs into a dedicated repo.

## Set up your own platform

1. Scaffold a domain and author the first requirement — no hand-written JSON needed:
   ```shell
   $ spec domain new ORDERS
   $ spec req orders --text "An order total equals the sum of its line items." \
       --why "Mispriced orders ship money out the door silently." \
       --lives "checkout/src/total.ts"
   ```
2. Add a member repo beside `spec-engine/` with `@spec ORDERS-001` tags in source and test files
3. Pin the member: `spec init checkout` (the default pin is the derived platform version)
4. Index and check: `spec index && spec check`

See the [Platform Setup guide](/guides/platform-setup/) for the full walkthrough.
