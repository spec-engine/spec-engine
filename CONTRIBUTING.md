# Contributing to Spec Engine

A Bun + TypeScript monorepo. This file covers setup, conventions, and process for
human contributors.

- The `spec` CLI contract (commands, exit codes, `--json` shapes): the [agent reference](packages/site/src/content/docs/agent-reference.md)
- Rules for changing the engine: [AGENTS.md](AGENTS.md)
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

CI releases and publishes, keyless:

- `release-please` (a job in `.github/workflows/ci.yml`, configured by
  `release-please-config.json` and `.release-please-manifest.json`) runs on every
  push to `main`.
- The `publish` job in the same workflow ships to npm via OIDC trusted publishing,
  after every gate job in that run passes.
- No stored token. Provenance is attached automatically (`publishConfig.provenance`).
- One-time prerequisites: the npm org `spec-engine` exists, and the GitHub trusted
  publisher is registered for `@spec-engine/spec-engine` (org `spec-engine`, repository
  `spec-engine`, workflow `ci.yml`, no environment).
- One-time repository prerequisites: the setting "Allow GitHub Actions to create and
  approve pull requests" is on (release-please opens its PR with `GITHUB_TOKEN`), and
  the Renovate GitHub App is installed on the repository.

<!-- @spec DIST-024 -->
Release loop:

1. Merge pull requests with conventional-commit titles (`feat:`, `fix:`, `feat!:`).
2. release-please opens or updates one release PR that bumps
   `packages/engine/package.json`, the manifest, and `packages/engine/CHANGELOG.md`.
   A `Release-As: x.y.z` commit footer overrides the computed version.
3. Merging the release PR tags `v<version>`, creates the GitHub Release, and publishes
   in that same run. A tag pushed with `GITHUB_TOKEN` starts no other workflow.
   <!-- @spec DIST-024 --> The publish job refuses a tag that does not match the
   package version and re-runs the pack rehearsal (file list is `dist/` +
   `package.json`/`README.md`/`LICENSE` only; no `workspace:*` survives in the
   manifest) before uploading.

A hand-pushed `v<version>` tag still re-runs every gate and publishes, for a release
cut outside release-please.

Dependencies are exact pins. Renovate (`renovate.json`) keeps them exact and current:
one weekly PR for grouped minor and patch updates, a separate PR per major, and a
weekly `bun.lock` maintenance PR.

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
