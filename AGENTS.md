# Spec Engine — builder reference

Rules for agents changing the engine in this repository.

- The `spec` CLI contract (the model, the requirement authoring standard,
  every command, exit code, and `--json` shape) is the
  [agent reference](packages/site/src/content/docs/agent-reference.md). It is
  the one copy: the docs site renders it, and adopter repositories receive it.
- Narrative and rationale: [README](README.md).
- Process, setup, PR flow: [CONTRIBUTING.md](CONTRIBUTING.md).
- Terminology: [GLOSSARY.md](GLOSSARY.md).
- Domain charters: [spec-engine/TAXONOMY.md](spec-engine/TAXONOMY.md).
- Components, seams, invariants: the
  [architecture page](packages/site/src/content/docs/architecture.md).

A CI test (`packages/engine/src/cli.docs-agents.test.ts`) fails if any public
subcommand in `packages/engine/src/cli.ts` is missing from the agent
reference.

## Working in this repo

This repo dogfoods its own `@spec` protocol: requirements live in
`spec-engine/<DOMAIN>/SPEC.json`, code binds to them with `@spec` tags.

Gates to keep green before a PR:

```bash
bun test                                      # full suite
bunx biome check .                            # lint + format
bun run typecheck
bun packages/engine/src/cli.ts check . --ci   # the self-gate
bash scripts/arch-fences.sh                   # the grep fences
```

Rules:

- **The derived index owns nothing.** Never encode truth in `.spec-engine/`. It
  is rebuilt from `spec-engine/` plus `@spec` tags and must rebuild identically.
- **Coverage is a SQL view**, never a materialized table.
- **An operation is written once**, under `packages/engine/src/operations/`.
  A command file, an API route, an MCP tool, and the webapp parse their
  input, call the operation, and render the result. An input the operation
  accepts is exposed on every surface that calls it, and
  `operations/parity.test.ts` proves the surfaces write the same envelope.
- **Keep the planted defects in `fixtures/`.** They exist so `spec check` has
  something to catch.
- **Exactly one `bun:sqlite` import**, in `packages/engine/src/storage/sqlite.ts`.
  Enforced by `fence_d08_engine_internal` in `scripts/arch-fences.sh` (SCHM-025).
- **Every `SPEC.json` read parses through the shared schema.** `parseDomainText`
  in `packages/shared/src/domain.ts` is the one place bytes become a domain
  envelope, and every operation, check, and reader consumes the `SpecDomain`
  it returns. `JSON.parse` otherwise appears only in the readers that own
  their own schema (the member config, the root `package.json`, the HTTP
  body), and nothing in production source casts through `unknown`. Enforced
  by `fence_schm030_schema_reads` (SCHM-030).
- **A test authors its platform through the operations.** `TestPlatform` in
  `packages/engine/src/testing/platform.ts` scaffolds domains, mints,
  supersedes, deprecates, moves, mints terms, and writes member configs by
  calling `operations/`, so a fixture is what a `spec` command would have
  written. A state the engine refuses to author (a removed entry, an
  unapproved status flip, a forward `supersedes` pointer, a grammar declared
  after the fact) is planted with `plantEdit` in `src/testing/plant.ts`, which
  still writes through `validateAndWrite`. A schema-invalid file lives under
  `src/testing/fixtures/`. Nothing else writes a `SPEC.json` by hand: the
  SCHM-035 fence scans every source file and every test. A rewrite of an
  existing file preserves its shape: unchanged entries stay byte-identical, a
  changed entry keeps its key order, and an appended entry takes the key order
  of the last one (SCHM-031..034).
- **Membership is platform-map's; the pin is ours.** Which directories are
  members, and whether a repo is a monorepo, comes from
  `@spec-engine/platform-map` (`map()` and `locate()`, imported only in
  `packages/engine/src/indexer/discover.ts`). This checkout is a lone
  monorepo with no platform file: its coverage columns are the root
  `workspaces` packages (`packages/*` and `scripts`), each pinned to the
  derived platform version unless it carries a nested
  `spec-engine.member.json` (`scripts/` does), plus a `root` column for the
  files outside every package (the directory is named `spec-engine`, so
  the column cannot take its name). A fixture platform
  (`fixtures/platform-fixture`, the trees under `src/testing/fixtures/`)
  carries a `platform-map.json` platform file, a marker and a private
  `package.json` per member. See the
  [platform-mapping page](packages/site/src/content/docs/platform-mapping.md).
- **A member config, a platform file, and a marker are authored with
  `spec init`, never by hand.** This checkout is the engine's own platform
  (the root `package.json` is `@spec-engine/spec-engine`), so `spec init`
  judges the spec-engine/ path-segment refusal below the platform root and
  `spec init scripts` works here (INIT-030). Rewrite a pin with
  `spec init <dir> --force`. A fixture platform under `fixtures/` is
  declared by running `spec init` on a temporary copy of the tree and
  copying the two `platform-map.json` files back: the checkout's own path
  carries a `spec-engine` segment, and only the engine platform is judged
  below its root.
- **Every fence is a requirement.** Each `fence_*` function in
  `scripts/arch-fences.sh` carries the `@spec` tag of the requirement it
  enforces, and its `run` label starts with that id. `scripts/` is a
  workspace package (`scripts/package.json`) with its own pin
  (`scripts/spec-engine.member.json`) so those tags index; the scanner reads
  `.sh` files as code.
- **The planted-fixture diagnostic baseline is one file**,
  `fixtures/platform-fixture.diagnostics.json`, read by
  `packages/engine/src/commands/check.ci.test.ts` and by smokes 7, 18, and
  23. A change to the planted set moves that file only.
- **The CI smokes are scripts.** `bash scripts/smoke.sh` runs every
  `scripts/smoke/NN-*.sh` in order against `./dist/spec` (`bun run build:cli`
  first); `bash scripts/smoke.sh 7` runs one. `.github/workflows/ci.yml`
  calls the same scripts, and `shellcheck` over `scripts/` is a lint step, so
  a red smoke reproduces locally before it costs a CI cycle.
- **A test lives beside the file it tests.** `foo.ts` is tested by `foo.test.ts`
  in the same directory; a second test file for the same source is
  `foo.<aspect>.test.ts` (`check.ci.test.ts`, `sqlite.fts.test.ts`). Shared
  helpers and planted trees live in `packages/<pkg>/src/testing/`. Only a test
  of a package- or repo-wide invariant with no single file under test
  (`architecture-fences`, `corpus-hygiene`, `taxonomy`, `npm-package`, the
  webapp import fence) lives in `packages/<pkg>/test/`. The tag scanner
  classifies a file as a test by the `.test.` substring, so a co-located tag
  still verifies; the engine-internal fences skip `*.test.ts` and
  `src/testing/`, the write-seam fence does not.
- **stdout goes through `packages/engine/src/stdout.ts`.** `cli.ts` routes
  `console.log` through the stream, and a command that prints its result and
  then ends the process calls `exit()` from that module, never `process.exit`.
  Bun drops stdout bytes still queued when `process.exit` runs, so a piped
  `--json` report larger than one pipe buffer was cut off.
- **A fence runs inside `bun test` under a 5-second budget**
  (`architecture-fences.test.ts` spawns the whole script). Keep each fence to
  one process.

Comments:

- A comment carries a mechanical constraint the code cannot state. Nothing else.
- Before writing one, prefer a named function, a test, or an `@spec KEY-NNN` tag.
- Never restate a requirement, name a plan, phase, wave, pitfall, or review
  round, or narrate how the code got here. Behavior lives in `SPEC.json`.
- A test name is a comment the runner prints: it claims only what the body
  exercises and carries no process token.

## Invocation in this checkout

```
bun packages/engine/src/cli.ts <command> [...]   # from source (the default here)
./dist/spec <command> [...]                     # compiled binary (bun run build:cli)
```

Before a PR, run the agent loop from the agent reference against this
checkout: `spec index . && spec check . --ci`, then `spec guard .`. When
`spec guard` blocks, relay the `🛑 spec-guard:` block verbatim to the user.
