---
title: Adoption Guide
description: Progressive adoption of Spec Engine — bottom-up, rung by rung
---

Spec Engine is adopted in steps, like climbing a ladder one rung at a time — each rung is a working setup on its own, and each adds one thing.

## Rung 1: Stop re-explaining to the AI

Durable requirements the agent retrieves instead of you re-typing context every session. One repo, specs inline, zero ceremony — `spec map`/`check` work against a lone repo with no sibling members and no config.

Free, local.

## Rung 2: Prove it

`@spec` tags bind tests to requirements; `spec check --ci` gates. Still one repo, free, local.

## Rung 3: Coordinate it

Promote specs to a dedicated `spec-engine` repo; a requirement change is approved by merging it there, and a consuming repo's PR is blocked until the requirement it depends on is approved upstream.

Multiplayer — planned as a paid hosted service; today rung 3 runs free on your own machines.

## Dogfooding note

This repo is its own platform (monorepo mode): the root `spec-engine/` holds the requirement domains, and every `packages/*` workspace member carries the `@spec` tags that bind them — one coverage column per package via the `"members": "*"` expansion in `packages/spec-engine.member.json`.

```shell
$ spec map .                     # the requirement × package coverage matrix
$ spec check . --ci              # the self-gate; CI runs this on every push
$ spec query "approval gate" .   # ranked hits — the Gate term + GATE-008
```
