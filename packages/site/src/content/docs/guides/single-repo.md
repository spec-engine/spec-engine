---
title: Single Repo (Rung 1)
description: Getting started with one repo, specs inline, zero ceremony
---

The bottom rung of the adoption ladder: one repo, specs inline, zero ceremony — no sibling members, no `spec-engine.member.json`, no `spec init`.

## Layout

```
my-repo/
  spec-engine/
    ORDERS/SPEC.json          ORDERS-001 / ORDERS-002 / ORDERS-003
  src/
    orders.ts                 // @spec ORDERS-001   // @spec ORDERS-002
  test/
    orders.test.ts            // @spec ORDERS-001 unit
```

## Commands

```shell
$ spec index .
$ spec map .
$ spec check .
```

Spec Engine registers the repo as its own lone member and scans it for tags. The coverage column is the repo's own basename.

## Promote to multi-repo

When you outgrow one repo:

```shell
$ git mv spec-engine/ ../spec-engine
```

This lifts the inline specs into a dedicated repo beside this one, turning rung 1 into a multi-repo platform. The repo then pins to it with `spec init` like any member.
