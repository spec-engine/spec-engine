# Contributing to Spec Engine

A Bun + TypeScript monorepo. This file covers setup, conventions, and process for
human contributors.

- Machine-facing engine reference (commands, exit codes, `--json` shapes): [AGENTS.md](AGENTS.md)
- Terminology: [GLOSSARY.md](GLOSSARY.md)
- Components, seams, invariants: the [architecture page](packages/site/src/content/docs/architecture.md)

## Before you start

- For anything beyond a small fix, open an issue first so we can agree on the approach.
- By contributing you agree your work is licensed under the project's [MIT License](LICENSE).

## Setup

This section is for **developing Spec Engine itself**. To *use* it, you don't need a
checkout at all — install the published package (`bun add -g @spec-engine/spec-engine`)
and see the [README](README.md#30-seconds-to-value).

```bash
bun install
bun test           # full suite
bunx biome check . # lint + format
```

Run the CLI from source: `bun packages/engine/src/cli.ts <command>`, or compile it with
`bun build --compile packages/engine/src/cli.ts --outfile=dist/spec`.

## The `@spec` protocol

Spec Engine dogfoods itself. Requirements live in `spec-engine/<DOMAIN>/SPEC.json` as
durable ids (e.g. `INIT-015`); code binds to them with a `@spec` tag:

```ts
// @spec INIT-015   in a source file: implements the requirement
// @spec INIT-015   in a test file: proves it
```

What a tag means comes from where it sits — the file path decides implements
vs. proves. Never write those words in the tag; a test tag may carry an
optional level token (`unit` | `integration` | `e2e`).

Before opening a PR, keep the self-gate green:

```bash
bun packages/engine/src/cli.ts check . --ci
```

## Conventions

- Match the style of the code you're editing; `biome` is the formatter and linter.
- The architecture rules (the derived index owns nothing, coverage is a SQL view, one
  engine not two, one `bun:sqlite` import) are on the
  [architecture page](packages/site/src/content/docs/architecture.md) and enforced by
  `scripts/arch-fences.sh`.
- Keep the planted defects in `fixtures/`. They exist so `spec check` has something to
  catch.

## Workflow

1. Fork and branch from `main` (`type/short-description`).
2. Make your change. Add or update tests — this repo dogfoods its own `@spec` protocol.
   A test lives beside the file it tests (`foo.ts` → `foo.test.ts`, or
   `foo.<aspect>.test.ts` for a second file); shared helpers go in
   `packages/<pkg>/src/testing/`. See AGENTS.md for the full rule.
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
`shared`/`tracker`/`webapp`/`site` stay private forever).

CI publishes on tag, keyless:

- Pushing a `v<version>` tag re-runs every CI gate on the tagged commit, then the
  `publish` job in `.github/workflows/ci.yml` ships to npm via OIDC trusted publishing.
- No stored token. Provenance is attached automatically (`publishConfig.provenance`).
- One-time prerequisites: the npm org `spec-engine` exists, and the GitHub trusted
  publisher is registered for `@spec-engine/spec-engine` (org `spec-engine`, repository
  `spec-engine`, workflow `ci.yml`, no environment).

Release loop:

1. Bump `version` in `packages/engine/package.json`, run `bun install` (a
   stale lockfile packs the wrong number), and land the bump on `main`
   through a normal PR.
2. Tag and push: `git tag v<version> && git push --tags`. CI does the rest —
   the publish job refuses a tag that doesn't match the package version, and
   re-runs the pack rehearsal (file list is `dist/` +
   `package.json`/`README.md`/`LICENSE` only; no `workspace:*` survives in the
   manifest) before uploading.

Inside the publish job:

- `bun pm pack` runs `prepack` and rewrites the `workspace:` protocol.
- `npm publish <tarball>` (npm 11.5.1 or newer) does the keyless OIDC upload. `bun publish`
  has no OIDC flow.
- Manual fallback, only if CI is unavailable: `bun publish --access public --auth-type web`
  from `packages/engine`. Never `npm publish` from the directory; npm cannot rewrite
  `workspace:`.

## Reporting bugs

Open an issue using the bug template. Include the command you ran, what you expected,
and what happened (with `--json` output where relevant).
