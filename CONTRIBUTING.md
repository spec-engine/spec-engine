# Contributing to spec-check

Thanks for your interest. This is a Bun + TypeScript monorepo — one engine, shared
schema types, a CLI and a webapp reading through the same storage interface.
This file covers setup, conventions, and process for human contributors. The
machine-facing engine reference (command loop, exit codes, `--json` schemas)
lives in **[AGENTS.md](AGENTS.md)**; canonical terminology (domain vs spec vs
requirement, and the rest) lives in **[GLOSSARY.md](GLOSSARY.md)**.

## Before you start

- For anything beyond a small fix, open an issue first so we can agree on the approach.
- By contributing you agree your work is licensed under the project's [MIT License](LICENSE).

## Setup

```bash
bun install
bun test           # full suite
bunx biome check . # lint + format
```

Run the CLI from source: `bun packages/engine/src/cli.ts <command>`, or compile it with
`bun build --compile packages/engine/src/cli.ts --outfile=dist/spec`.

## The `@spec` protocol

spec-check dogfoods itself. Requirements live in `spec-engine/<DOMAIN>/SPEC.json` as
durable ids (e.g. `INIT-001`); code binds to them with a `@spec` tag:

```ts
// @spec INIT-001            implements the requirement
// @spec INIT-001 verifies   proves it (in a test)
```

Before opening a PR, keep the self-gate green:

```bash
bun packages/engine/src/cli.ts check . --ci
```

## Conventions

- Match the style of the code you're editing; `biome` is the formatter and linter.
- **The derived index owns nothing.** Never encode truth in `.spec-engine/`; it is
  rebuilt from `spec-engine/` + `@spec` tags and must produce an identical result when
  deleted and rebuilt. It is never committed.
- **Coverage is a SQL view**, never a materialized table — it cannot drift from the tags.
- **Structural integrity** (`DUP_ID`, `BROKEN_SUPERSEDE`, `BAD_STATUS`) is validated
  against the parsed spec at index time, not enforced as DB constraints.
- **One engine, not two.** CLI and webapp share the schema types via the `shared`
  package. No forked logic that can drift between surfaces.
- Keep the planted defects in `fixtures/` — they exist so `spec check` has something to
  catch. Don't "fix" them to make the gate pass.

## Workflow

1. Fork and branch from `main` (`type/short-description`).
2. Make your change. Add or update tests — this repo dogfoods its own `@spec` protocol.
3. Keep the gates green:
   ```bash
   bun test
   bunx biome check .
   bun packages/engine/src/cli.ts check . --ci
   ```
4. Open a PR against `main` with a clear description of the what and the why.

## Releasing (npm)

Only `packages/engine` publishes — as **`@spec-engine/spec-engine`**, a single
bundled package (the workspace packages inline into `dist/impl.js` at prepack;
`shared`/`tracker`/`webapp`/`site` stay private forever). One-time
prerequisites: the free npm **org `spec-engine`** must exist with you as a
publisher, and you must be logged in (`npm login`).

Release loop, from the repo root:

1. Bump `version` in `packages/engine/package.json`.
2. `bun install` — refreshes `bun.lock` (bun resolves pack-time versions from
   the lockfile; a stale one packs the wrong number).
3. Rehearse: `cd packages/engine && bun pm pack --dry-run` — the file list must
   be `dist/` + `package.json`/`README.md`/`LICENSE` only. Then
   `bun pm pack && tar -xOf *.tgz package/package.json` and confirm no
   `workspace:*` survives anywhere in the manifest; delete the tarball.
4. Publish the **directory** (never a pre-packed tarball — that skips the
   `prepack` build): `bun publish --access public --auth-type web` from
   `packages/engine`. Always `bun publish`, never `npm publish` — only bun
   rewrites any residual `workspace:` protocol.
5. Tag and push: `git tag v<version> && git push --tags`.

## Reporting bugs

Open an issue using the bug template. Include the command you ran, what you expected,
and what happened (with `--json` output where relevant).
