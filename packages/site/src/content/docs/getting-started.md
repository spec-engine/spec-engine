---
title: Getting Started
description: Install Spec Engine from npm and run your first check in under a minute
---

## Install

Spec Engine ships as one npm package — `@spec-engine/spec-engine` — carrying the `spec` CLI, the local webapp (`spec serve`), and these docs offline (`spec docs`). No clone, no build step, no service.

It needs the [Bun](https://bun.sh) runtime (>= 1.3): the index engine uses `bun:sqlite` and does not run under Node.

```shell
$ bunx @spec-engine/spec-engine --help    # run it once, without installing
$ bun add -g @spec-engine/spec-engine     # or put the `spec` bin on your PATH
```

Every example in these docs calls the CLI as plain `spec`, which is what the global install gives you. If you'd rather not install, read `spec <command>` as `bunx @spec-engine/spec-engine <command>` throughout — the two are interchangeable.

## Your first platform in ~60 seconds

Nothing here needs a checkout. In any repo of your own:

**1. Scaffold a domain and author the first requirement** — no hand-written JSON:

```shell
$ spec domain new ORDERS
created spec-engine/ORDERS/SPEC.json

$ spec req orders --text "An order total equals the sum of its line items." \
    --why "Mispriced orders ship money out the door silently." \
    --lives "src/orders.ts"
appended ORDERS-001 to spec-engine/ORDERS/SPEC.json
```

**2. Bind code to it** with a `@spec` tag — implementation and test:

```ts
// src/orders.ts
export function total() { /* … */ }        // @spec ORDERS-001

// test/orders.test.ts
it("sums line items", () => {})            // @spec ORDERS-001 unit
```

The tag kind is path-derived: a tag in implementation code *implements*, a tag in a test path *verifies*. You never write those words yourself.

**3. See the coverage matrix** — every requirement × every repo:

```shell
$ spec map .
DOMAIN  REQUIREMENT  STATUS  my-app    spec-engine
ORDERS  ORDERS-001   Active  src+test  —
```

Each cell is `src` (implemented), `test` (verified), `src+test` (both), or `—` (no coverage).

**4. Check integrity** — dangling tags, drift, orphans, superseded references:

```shell
$ spec check .
```

Exit `0` is clean; exit `1` means an error-severity diagnostic you should fix before merging. That's the whole loop: **write specs, tag code, check the platform.**

## Explore the shipped fixtures

The [repo](https://github.com/spec-engine/spec-engine) ships `fixtures/platform-fixture` — a canonical `spec-engine/` plus three member repos, with drift deliberately planted so `spec check` has something to catch. The fixtures are test data and are **not** part of the npm package, so this one needs a clone:

```shell
$ git clone https://github.com/spec-engine/spec-engine && cd spec-engine
$ spec map fixtures/platform-fixture
DOMAIN   REQUIREMENT  STATUS      admin     api       mobile  spec-engine
AUTH     AUTH-001     Active      —         —         —       —
BILLING  BILLING-001  Superseded  —         —         src     —
BILLING  BILLING-002  Active      —         src       —       —
BILLING  BILLING-007  Active      src+test  src+test  src     —
BILLING  BILLING-009  Active      —         src+test  —       —
```

## Single repo (rung 1)

The bottom rung: one repo, specs inline, zero ceremony. A repo with an in-repo `spec-engine/<DOMAIN>/SPEC.json` and a `@spec` tag in its own code self-consumes — no sibling members, no `spec init`:

```
my-repo/
  spec-engine/
    ORDERS/SPEC.json          ORDERS-001 / ORDERS-002 / ORDERS-003 (active)
  src/
    orders.ts                 // @spec ORDERS-001   // @spec ORDERS-002
  test/
    orders.test.ts            // @spec ORDERS-001 unit
```

**Promote to multi-repo** when you outgrow one repo: `git mv spec-engine/ ../spec-engine` lifts the inline specs into a dedicated repo.

## Grow to a platform

1. Add a member repo beside `spec-engine/` with `@spec ORDERS-001` tags in source and test files
2. Pin the member: `spec init checkout` (the default pin is the derived platform version)
3. Index and check: `spec index && spec check`

See the [Platform Setup guide](/guides/platform-setup/) for the full walkthrough.

## Read these docs offline

The package embeds this whole site. No network needed:

```shell
$ spec docs
```
