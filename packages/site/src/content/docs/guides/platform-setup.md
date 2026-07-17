---
title: Platform Setup
description: Set up a multi-repo platform from scratch
---

A platform is a directory holding a canonical `spec-engine/` folder plus one or more member repos beside it. Every step below is a CLI command — you never hand-write JSON.

Need the CLI first? `bun add -g @spec-engine/spec-engine` puts `spec` on your PATH — no clone required. See [Getting Started](/getting-started/).

## Step 1: Create the domain and its first requirement

```shell
$ spec domain new ORDERS
created spec-engine/ORDERS/SPEC.json

$ spec req orders --text "An order total equals the sum of its line items." \
    --why "Mispriced orders ship money out the door silently." \
    --lives "checkout/src/total.ts"
appended ORDERS-001 to spec-engine/ORDERS/SPEC.json
```

`spec req` appends a born-active entry through the same validated write seam every surface uses. The result on disk:

```json
{
  "key": "ORDERS",
  "owner": null,
  "updated": "2026-07-16",
  "requirements": [
    {
      "id": "ORDERS-001",
      "status": "active",
      "statement": "An order total equals the sum of its line items.",
      "why": "Mispriced orders ship money out the door silently.",
      "livesIn": ["checkout/src/total.ts"]
    }
  ]
}
```

Note there is no version counter in the file — the domain's version is derived from its supersede history.

## Step 2: Add a member

Beside `spec-engine/`, make a `checkout/` repo with tagged files:

```ts
// checkout/src/total.ts
export const total = 0;          // @spec ORDERS-001

// checkout/test/total.test.ts
export const t = 1;              // @spec ORDERS-001 unit
```

## Step 3: Pin and index

```shell
$ spec init checkout
spec init: wrote checkout/spec-engine.member.json
  pin:    spec-engine@1
  source: derived platform version (max domain version 1 at …)

$ spec index
$ spec map
DOMAIN  REQUIREMENT  STATUS  checkout  spec-engine
ORDERS  ORDERS-001   Active  src+test  —

$ spec check
```

The default pin is the **derived platform version** — the max of the domains' derived versions — so a fresh member is born current. As requirements supersede, the domain version advances; a member still pinned behind lights up as `DRIFT` for the requirements it actually references.

## Next steps

- Add `@spec` tags as you touch code — no big migration
- Put `spec check --ci` in your CI gate, and `spec guard` in pre-commit for loss detection
- Point your agent at `spec query` / `spec resolve` (or `spec mcp`) so it retrieves requirements
- Promote to a dedicated `spec-engine` repo when you go multi-repo
