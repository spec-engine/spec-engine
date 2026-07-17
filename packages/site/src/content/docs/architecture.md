---
title: Architecture
description: Canonical git + derived index + local webapp
---

Canonical truth lives in **git, in a dedicated spec location** — a `spec-engine` repo (polyrepo) or a spec package (monorepo). Keeping truth in git means requirement changes are reviewed and merged as PRs, history is free and diffable, supersession is atomic at merge, and IDs allocate safely.

Over that canonical truth, the engine maintains a **derived database** — a `bun:sqlite` index, rebuildable at any time, that exists purely for speed and cross-repo queries. It owns nothing.

```
spec (CLI)            engine: indexer + checks + the bun:sqlite derived index
spec serve            local webapp reading the derived index
spec mcp              the same engine exposed as an MCP server over stdio
spec-engine/          canonical requirements, in git (a repo or a package)
@spec-engine/tracker  optional, online adapter resolving issue IDs → titles/URLs
```

## One engine, not two

The CLI, the local webapp, and the MCP server all read and write through the same storage interface and share one schema (the `shared` package). No forked logic that can drift between surfaces — a spec engine that drifts from itself is the one thing the project cannot ship.

## Engine offline, adapter online

The engine treats issue IDs as opaque strings and never makes a network call — everything in the closed loop (requirements, code, tests, git, the derived index) works with zero external services. Issue-tracker [provenance](/format/#provenance-issues) is an **additive** join: the optional `@spec-engine/tracker` adapter resolves IDs to titles and URLs, isolated behind a CI import fence so the core stays portable. Removing the adapter leaves the engine fully functional.

## Where it sits

Your build stack is a vertical of layers: the model at the base, the coding agent on top, an orchestration layer (DFC) above that, work entering from an issue tracker. Spec Engine is not another layer in that stack. It sits beside it as the store every layer reads from and writes to — closer to a database than to a tool in the pipeline.
