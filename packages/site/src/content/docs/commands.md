---
title: Commands
description: Complete CLI command reference
---

All commands are run via `bun packages/engine/src/cli.ts <command> [args]` or `./dist/spec <command> [args]`.

## Exit code contract

| Code | Meaning |
| --- | --- |
| 0 | Success. Empty results are success (`[]` on stdout, guidance on stderr). |
| 1 | Data-level failure: `check` found ≥1 error-severity diagnostic; `guard` found a loss; `gate` failed; `index` crashed mid-build. |
| 2 | Usage/environment error: bad args, not a spec-check platform, path-containment violation, etc. |

## Common flags

Index-touching commands (`index`, `check`, `map`, `query`, `relations`, `resolve`, `propagation`, `provenance`, `gate`, `serve`) accept:

- `--out <path>` — DB path override (must resolve inside `platformDir`)
- `--no-prompt` — suppress interactive onboarding prompt
- `--json` — emit structured output (all except `serve`)

Read commands (`map`, `query`, `relations`, `resolve`, `propagation`, `provenance`) trust a schema-matching existing index; pass `--fresh` to force a cold rebuild first. `check --ci` and `gate` always rebuild cold — correctness never trusts a warm index.

## Command reference

### `spec index [platformDir]`

Build or refresh the derived SQLite index at `<platformDir>/.spec-engine/index.sqlite`. `--json` emits `{ build_id, repos, domains, requirements, tags, diagnostics }`; `build_id` is deterministic for identical inputs.

**Exit codes:** 0 / 1 / 2

### `spec check [platformDir]`

Cross-repo integrity, coverage, and drift diagnostics. See [Integrity Checks](/checks/) for every code.

| Flag | Description |
| --- | --- |
| `--ci` | Force cold rebuild (delete DB first) |
| `--results <junit.xml>` | Trusted-red proof gate: a verifying tag only counts when its test *passed* — fires `UNPROVEN_REQ` otherwise. Without it, `PROOFS_UNCONFIRMED` reminds you the gate is presence-only |
| `--base <ref>` | Governance diff against a git ref: fires `REQUIREMENT_REMOVED` / `UNAPPROVED_STATUS_FLIP` (and `PARTIAL_PROPAGATION` with `--results`) |
| `--approved-by <list>` | Approver set consulted by the status-flip governance check |
| `--require-owner-approval` | Escalate `UNAPPROVED_STATUS_FLIP` from warning to error |
| `--unsourced-change` | Opt-in: warn on superseded requirements lacking a `supersedes-via` issue |

**Exit codes:** 0 (clean) / 1 (errors found) / 2 (crash)

### `spec guard [platformDir]`

The pre-commit **loss gate**: diffs the requirement derivation at `--against <ref>` (default `HEAD`) against the working tree and blocks what the change is about to steamroll. Losses: `REQUIREMENT_REMOVED` (an active requirement gone with no supersession), `IMPL_LOST` / `VERIFY_LOST` (a surviving requirement's last implementing/verifying tag removed), `SPEC_FILE_DELETED`. A loss is suppressed by superseding the requirement in the same change or an explicit `// @spec approve KEY-NNN <reason>` comment. A non-git tree or unknown ref warns and exits 0 — the guard is a safety net, not a git dependency.

| Flag | Description |
| --- | --- |
| `--against <ref>` | Git ref to diff against (default `HEAD`) |
| `--json` | Emit `{ kind, req_id, file, line, detail }` rows, byte-stable |

**Exit codes:** 0 (clean) / 1 (loss found) / 2

### `spec map [platformDir]`

Render the cross-repo coverage matrix. **Exit codes:** 0 / 2

### `spec query <text> [platformDir]`

Full-text retrieval over requirements (FTS5, BM25-ranked, best first). Superseded requirements are excluded. Glossary term definitions ride the same index and surface in a separate Terms group. `--limit N` (default 10, max 1000). Wrap multi-word phrases in quotes; bare `AND`/`OR` is an FTS5 grammar error (exit 2).

**Exit codes:** 0 / 2

### `spec relations [platformDir]`

Render `relates` links as a mermaid `graph LR` diagram (text mode) or `{ from_id, to_id, source_file, line }` rows (`--json`). **Exit codes:** 0 / 2

### `spec provenance [issueId] [platformDir]`

Per-requirement provenance matrix: the issues that created/revised/retired it (by role), the backing tests, and a git pointer. An optional leading `<issueId>` is a display-only reverse-lookup filter — the issue ID stays opaque, never a join key. `--resolve-issues` overlays tracker title/status/URL via the optional adapter (needs `SPEC_TRACKER_TOKEN`; off by default, degrades gracefully).

**Exit codes:** 0 / 2

### `spec resolve <files...> [platformDir]`

Requirements tagged in the given files. Accepts multiple positionals, comma-split within a positional, and absolute paths under the platform tree. `--req KEY-NNN` inverts the lookup: every tag site for that requirement across all repos.

**Exit codes:** 0 / 2

### `spec propagation <reqId> [platformDir]`

Classify each member repo's relationship to a superseded requirement: `MIGRATED_VERIFIED`, `MIGRATED_UNVERIFIED`, `ON_PREDECESSOR`, `ON_OTHER_DOMAIN_REQ`, `NO_DOMAIN_REFERENCE` — plus a `drifted` flag per member.

**Exit codes:** 0 / 2

### `spec gate <repo> <reqId> [platformDir]`

Approval primitive. Passes iff `<reqId>` is Active AND `<repo>`'s pin covers the requirement's `changed_at_version`. **Decision order:** `NOT_FOUND` → `DRAFT` → `SUPERSEDED` → `VERSION_PIN` → `PASS`; pin equality passes. An unknown repo is a usage error (exit 2), not a gate failure.

**Exit codes:** 0 (PASS) / 1 (failure) / 2 (bad args)

### `spec init [repo]`

Scaffold `spec-engine.member.json` into a member repo. Pin resolution: `--specs <pin>` wins; else the **derived platform version** (the max of the enclosing platform's domain versions); else `spec-engine@1` with a printed note. An existing config is left untouched ("already configured", exit 0); `--force` rewrites the pin while preserving an `ignore` list. The config may also carry `"members": "<glob>"` for monorepo workspace expansion — each matching subdirectory becomes its own coverage column.

**Exit codes:** 0 / 2 (never exit 1)

### `spec domain new <name>` / `spec domain list [platformDir]`

Scaffold `spec-engine/<KEY>/SPEC.json` (input normalized to uppercase, whitespace stripped) / list domains with their charters (`--json`: sorted `{ key, scope }` array, read from the filesystem).

**Exit codes:** 0 / 2

### `spec migrate [platformDir]`

One-time hard cutover: convert every legacy canonical `SPEC.md` to a schema-validated sibling `SPEC.json`, then delete the `SPEC.md`. Idempotent — skips already-migrated dirs.

**Exit codes:** 0 / 2

### `spec req <domain-prefix> [platformDir]`

**Piped:** prints the next unused requirement ID (e.g. `BILLING-010`) — zero prompts, zero writes. **TTY:** interactive authoring. **`--text` (+ `--why` / `--binds` / `--lives`):** appends a born-active entry non-interactively through the validated write seam. Prefix is case-insensitive (`bil` → `BILLING`; ambiguous → exit 2). `spec req <domain>` alone prints the domain's charter before authoring.

**Exit codes:** 0 / 2

### `spec term …`

The glossary authoring surface — a term is a requirement row in the reserved `TERM` domain (definition in the statement, headword in `term`, synonyms in `aliases`):

- `spec term "<name>" --def "<definition>" [--aliases a,b] [--section s]` — author a `TERM-NNN`
- `spec term list` — every term's `id name status`, read from the filesystem
- `spec term revise <TERM-NNN> --def "…"` — rewrite a definition **in place** (same id) and bump the TERM envelope's authored `specVersion`, the pin citations drift against
- `spec term confirm <KEY-NNN> <TERM-NNN>` — re-pin a requirement's citation to the term's current version (clears `TERM_DRIFT`); re-points to the successor when the cited term was superseded (clears `SUPERSEDED_TERM_REFERENCED`)

`spec supersede` and `spec amend` work on TERM ids exactly as on requirements.

**Exit codes:** 0 / 2

### `spec glossary [platformDir]`

The GLOSSARY.md round-trip. Default: **generate** GLOSSARY.md from the TERM store, byte-stable and LLM-free. `--migrate`: one-time parse of an existing GLOSSARY.md into `TERM-001..N` (idempotent-skip). `--check`: regenerate into a buffer and fail (exit 1) if the committed file drifts — a CI fence.

**Exit codes:** 0 / 1 / 2

### `spec supersede <reqId> [platformDir]`

The post-ship lifecycle move, mechanized. Flips the entry to superseded, mints the successor (`--text` required non-TTY; `--why`/`--binds`/`--lives` default to copies), reindexes, and prints the **retag worklist** — every code site still on the old ID. The target must be Active.

On a requirement domain the reported `spec_version` is the **derived** domain version after the supersession — no authored counter is written, and `--no-bump` is a no-op (there is no counter to hold back). On the reserved TERM domain the authored `specVersion` still bumps (it is the term-drift pin) and `--no-bump` opts out.

`--json`: `{ old_id, new_id, file, spec_version, retag: [...] }`

**Exit codes:** 0 / 2

### `spec move <reqId> <NEW-DOMAIN> [platformDir]`

Cross-domain supersede for taxonomy reorganization: mints the successor as the next id in `<NEW-DOMAIN>` (which must exist), carrying the source's fields (`--text`/`--why`/`--lives` override), flips the source to superseded with a cross-domain `supersededBy`, and emits the retag worklist. Both envelopes validate before either is written — a reject never half-applies. Only Active requirements move; moving into the source's own domain is a usage error (use `supersede`).

**Exit codes:** 0 / 2

### `spec amend <reqId> [platformDir]`

Revise an unshipped requirement's fields in place — same ID, no version change (the domain version only derives from supersessions). Field flags name what changes (`--text`/`--why`/`--binds`/`--lives`, at least one); untouched fields stay byte-identical. Only Active and Draft entries amend.

**Exit codes:** 0 / 2

### `spec serve [platformDir] [--port N]`

Launch the local webapp over the derived index. Binds `127.0.0.1` only. `--probe` boots on an ephemeral port, smoke-tests, and exits.

**API routes:** `/api/coverage`, `/api/report` (per-domain rollup over Active reqs), `/api/repos`, `/api/platform` (the derived platform version), `/api/requirements[/:id]`, `/api/propagation/:id`, `/api/query?q=&limit=`, `/api/resolve?files=...`, `/api/relations[?format=mermaid]`, `/api/provenance`

**Exit codes:** 0 / 1 / 2

### `spec mcp [platformDir]`

Serve spec-check as a Model Context Protocol server over stdio. Tools: `spec_query`, `spec_resolve`, `spec_req_tags`, `spec_coverage_report`, `spec_check`, `spec_propagation`, `spec_next_id` — the same JSON the CLI's `--json` modes emit, reindexed fresh per call. Also advertises the `author_requirements` prompt (a static authoring playbook; the engine itself runs no model).

**Exit codes:** 0 / 2
