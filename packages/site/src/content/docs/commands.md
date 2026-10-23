---
title: Commands
description: Which spec command to reach for, by task
---

Install the CLI from npm: `bun add -g @spec-engine/spec-engine` puts `spec` on your PATH. Without a global install, run any command as `bunx @spec-engine/spec-engine <command> [args]`. See [Getting Started](/getting-started/) for the details.

This page groups the commands by task. The exact contract of each one (flags, `--json` shapes, exit codes) is in the [Agent Reference](/agent-reference/#command-reference), which is the one copy of it.

## Find the requirements a change touches

- [`spec query`](/agent-reference/#spec-query): full-text search over requirement statements and glossary terms.
- [`spec resolve`](/agent-reference/#spec-resolve): the requirements tagged in given files, or with `--req`, every tag site for one requirement.
- [`spec get`](/agent-reference/#spec-get) and [`spec list`](/agent-reference/#spec-list): one requirement's record, or every record with its history.

## Check a change before it ships

- [`spec check`](/agent-reference/#spec-check): integrity, coverage, drift, and governance diagnostics. See [Integrity Checks](/checks/).
- [`spec guard`](/agent-reference/#spec-guard): the pre-commit gate that blocks a change about to lose a requirement, its last implementation, or its last test.
- [`spec lint`](/agent-reference/#spec-lint): every statement-rule finding for the platform, a domain, or one requirement.
- [`spec gate`](/agent-reference/#spec-gate): the approval decision for one member and one requirement.

## Author and change requirements

- [`spec domain`](/agent-reference/#spec-domain): scaffold a domain, list the charters, or set a domain's statement grammar.
- [`spec req`](/agent-reference/#spec-req): print the next id, or mint a requirement.
- [`spec amend`](/agent-reference/#spec-amend), [`spec supersede`](/agent-reference/#spec-supersede), [`spec move`](/agent-reference/#spec-move), [`spec deprecate`](/agent-reference/#spec-deprecate), [`spec accept`](/agent-reference/#spec-accept): the requirement lifecycle.
- [`spec term`](/agent-reference/#spec-term) and [`spec glossary`](/agent-reference/#spec-glossary): glossary terms and the generated `GLOSSARY.md`.

## See coverage across a platform

- [`spec map`](/agent-reference/#spec-map): the requirement by member coverage matrix.
- [`spec propagation`](/agent-reference/#spec-propagation): which members have moved to a superseded requirement's successor.
- [`spec relations`](/agent-reference/#spec-relations) and [`spec provenance`](/agent-reference/#spec-provenance): related requirements, and the tickets behind each one.

## Set up and serve

- [`spec init`](/agent-reference/#spec-init): declare a member and write its pin. See [Platform Mapping](/platform-mapping/).
- [`spec index`](/agent-reference/#spec-index): build the derived index; every other command builds it when needed.
- [`spec migrate`](/agent-reference/#spec-migrate): the one-time cutover from `SPEC.md` to `SPEC.json`.
- [`spec serve`](/agent-reference/#spec-serve), [`spec mcp`](/agent-reference/#spec-mcp), [`spec docs`](/agent-reference/#spec-docs): the local webapp, the MCP server, and this site offline.
