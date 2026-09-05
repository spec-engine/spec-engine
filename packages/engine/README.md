# @spec-engine/spec-engine

The engine. Ships the `spec` CLI, the read-only local webapp (`spec serve`), the offline docs site (`spec docs`), and the MCP surface (`spec mcp`) — one package, one version.

## Install

Requires the [Bun](https://bun.sh) runtime (>= 1.3) — the index engine uses `bun:sqlite` and does not run under Node.

```bash
bunx @spec-engine/spec-engine --help    # run without installing
bun add -g @spec-engine/spec-engine     # or install the `spec` bin globally
```

## What it does

- Parses authored requirements, builds a derived sqlite index, and answers questions over it: coverage, drift, relations, propagation, provenance, full-text search.
- Enforces gates: `spec check --ci` for integrity and drift, `spec guard` for requirement loss.
- Exposes the same engine three ways: the `spec` CLI, a local webapp (`spec serve`), and MCP for agents (`spec mcp`).

## The derived index

- Lives at `<platformDir>/.spec-engine/index.sqlite`. It is derived and disposable.
- Read commands build it transparently when missing. Deleting it is always safe.
- The index owns nothing. A failed build leaves nothing behind. Coverage, drift, and propagation are SQL projections over tags, never authored.

## Commands

| Command | Purpose |
|---------|---------|
| `spec init <repo>` | Scaffold `spec-engine.member.json` into a member. |
| `spec map <dir>` | Platform-wide coverage matrix (requirement x repo). |
| `spec check <dir>` | Integrity and drift diagnostics. `--ci` for a cold, gate-able run. |
| `spec guard <dir>` | Loss detection: block a change that deletes a requirement, its last tag, or its test without superseding. |
| `spec propagation <REQID> <dir>` | Per-member migration state for one requirement. |
| `spec query <text> <dir>` | Full-text search across requirements. |
| `spec resolve <files...>` | Map changed files to the requirements they touch. |
| `spec req` / `spec supersede` / `spec amend` | Author and evolve requirements. |
| `spec domain` | Author and scaffold domains. |
| `spec gate` / `spec relations` / `spec provenance` | Approval gate, cross-refs, tracker provenance. |
| `spec serve <dir>` | Local read-only webapp for the matrix and detail views. |
| `spec docs` | Serve the bundled documentation site offline (loopback only). |
| `spec mcp` | Expose the engine to agents over MCP. |

Run `spec <command> --help` for flags. Many commands support `--json` for machine output.

## Source layout

| Path | Role |
|------|------|
| `cli.ts` | citty entrypoint. Lazy-imports every subcommand so the compiled binary starts fast. |
| `commands/` | One file per subcommand, plus `_args.ts` (shared flag specs) and `_shared.ts` (the CLI adapters over the operations). |
| `operations/` | One function per verb. The CLI, the HTTP API, and the MCP server all call these. |
| `indexer/`, `parser/`, `scanner/` | Authored input to derived index: discovery, `SPEC.json` parsing, `@spec` tag scanning. |
| `storage/` | The one `bun:sqlite` importer. |
| `check/`, `guard/`, `gate/`, `map/`, `query/`, `resolve/`, `relations/`, `propagation/`, `provenance/`, `results/` | The read and gate projections, each with a `format.ts` for text mode. |
| `authoring/`, `onboarding/`, `base/` | Requirement authoring, first-run guidance, git base-ref helpers. |
| `server/` | The Hono API behind `spec serve` and the MCP server behind `spec mcp`. |

Components, seams, and invariants: the [architecture page](https://docs.spec-engine.dev/architecture/).

## Build

```bash
bun build --compile --minify --target=bun-darwin-arm64 packages/engine/src/cli.ts --outfile=dist/spec
```

## Contracts

- Requirements are not issues. A tracker ticket is ephemeral; a `KEY-NNN` requirement is durable. One issue fans out into several requirements. Never use an issue number as a requirement id.
- A non-platform directory gets a friendly message and exit 2, and leaves no `.spec-engine/` artifact. A failed pre-flight leaves nothing behind.

See the repo `AGENTS.md` for the `@spec` protocol, exit codes, and `--json` schemas.
