# spec-check — agent reference

Machine-oriented reference for coding agents driving the `spec` CLI.
Humans wanting narrative and rationale: read the [README](README.md);
process, setup, and PR flow live in [CONTRIBUTING.md](CONTRIBUTING.md);
canonical terminology lives in [GLOSSARY.md](GLOSSARY.md) — a *domain* is
the concept, a *spec* is the SPEC.json artifact recording it, a
*requirement* is the durable KEY-NNN unit.
This file optimizes for the opposite: exact contracts, exit codes, and
copy-paste commands, in as few tokens as possible.

Completeness is enforced mechanically: a CI test
(`packages/engine/test/docs-agents.test.ts`) fails if any public subcommand
registered in `packages/engine/src/cli.ts` is missing from this file.

## Working in this repo

This repo dogfoods its own `@spec` protocol — requirements live in
`spec-engine/<DOMAIN>/SPEC.json`, code binds to them with `@spec` tags.
Before opening a PR, keep the gates green:

```bash
bun test                                      # full suite
bunx biome check .                            # lint + format
bun packages/engine/src/cli.ts check . --ci   # the self-gate
```

- **The derived index owns nothing.** Never encode truth in `.spec-engine/`;
  it is rebuilt from `spec-engine/` + `@spec` tags and must produce an
  identical result when deleted and rebuilt.
- **Coverage is a SQL view**, never a materialized table — it cannot drift
  from the tags.
- **One engine, not two.** CLI and webapp share the schema types via the
  `shared` package. No forked logic that can drift between surfaces.
- **Keep the planted defects in `fixtures/`** — they exist so `spec check`
  has something to catch. Don't "fix" them to make a gate pass.
- **Exactly one `bun:sqlite` import exists system-wide**, in
  `packages/engine/src/storage/sqlite.ts`; the authoring path
  (`commands/domain.ts`, `commands/req.ts`, `authoring/domains.ts`) and every
  other engine module import zero. This is a dev convention (an import-count
  architecture rule, not a product promise), enforced by the D-08 fence
  (`fence_d08_engine_internal` in `scripts/arch-fences.sh`) — which is broader
  than the authoring path: it forbids `bun:sqlite` anywhere in
  `packages/engine/src` except `storage/sqlite.ts`.

## Invocation

```
bun packages/engine/src/cli.ts <command> [...]   # from a checkout (PoC default)
./dist/spec <command> [...]                     # compiled binary (bun run build:cli)
```

- Almost every command takes an optional trailing `platformDir` positional
  (default: cwd). The platform dir is the directory that contains `spec-engine/`.
- All commands are non-interactive when stdin is not a TTY. The
  index-touching commands (`index` / `check` / `map` / `query` / `resolve` /
  `propagation` / `gate` / `serve`) also accept `--no-prompt` to force-suppress
  the member-onboarding prompt; `init` / `domain` / `req` do not register it.
- `--json` output is written to **stdout only**; guidance, warnings, and
  diagnostics chrome go to **stderr**. Parse stdout, surface stderr.

## Mental model (6 lines)

1. Canonical truth: `spec-engine/<DOMAIN>/SPEC.json` files in git — one JSON
   domain envelope `{ key, owner, specVersion, updated, requirements[] }` per
   key, validated by the one `@spec-engine/shared` schema every read/write surface
   shares. The Markdown (`SPEC.md`) parse path is removed; `spec migrate`
   was the one-time cutover. Requirement IDs (`KEY-NNN`) are permanent;
   changes supersede, never overwrite.
2. Code binds to requirements with comment tags: `// @spec KEY-NNN` (+ optional
   level token `unit` | `integration` | `e2e` on test tags).
3. Tag kind is path-derived: a tag in implementation code **implements**; a tag
   in a test path **verifies**. Never write those words in the tag.
4. The index at `<platformDir>/.spec-engine/index.sqlite` is **derived and disposable**
   — read commands build it transparently when missing; deleting it is always safe.
5. Coverage/drift/propagation are SQL projections over tags — never authored.
   Drift compares a member's pin (`spec-engine@N`, ONE platform-wide scalar)
   against each referenced requirement's `changed_at_version`, derived locally
   within its domain's supersede DAG; the platform version is the max domain
   version, derived too — `spec-engine.platform.json` is retired (a stray one
   is ignored with a warning).
6. **Requirements are not issues.** A tracker ticket (Linear/Jira/GitHub) is an
   ephemeral work event; it does not live past production. One issue typically
   fans out into SEVERAL durable requirements (its acceptance criteria). When
   authoring from an issue, mint a `KEY-NNN` per requirement — NEVER use the
   issue number as a requirement id, and never tag code with one. Issue links
   on a requirement (future `Issues:` field) are provenance annotations,
   opaque to the engine — not identity, not routing.

## Exit code contract

| Code | Meaning |
| --- | --- |
| 0 | Success. Empty results are success (`[]` on stdout, guidance on stderr). |
| 1 | Data-level failure: `check` found ≥1 error-severity diagnostic; `gate` failed (`NOT_FOUND` / `DRAFT` / `SUPERSEDED` / `VERSION_PIN`); `index` crashed mid-build. |
| 2 | Usage/environment error: bad args, not a spec-check platform (no `spec-engine/`), path-containment violation, invalid `--limit`/`--port`, FTS5 syntax error. |

Branch on exit codes, not on output text.

## Commands

| Command | Synopsis | `--json` | Exits |
| --- | --- | --- | --- |
| `spec index [platformDir]` | Build/refresh the derived index | yes (IndexResult) | 0 / 1 / 2 |
| `spec check [platformDir] [--ci]` | Integrity + coverage + drift diagnostics | yes (array) | 0 / 1 / 2 |
| `spec guard [platformDir] [--against <ref>]` | Loss detection: diff the requirement derivation at a git ref (default HEAD) vs the working tree; block requirements about to be steamrolled | yes (array) | 0 / 1 / 2 |
| `spec map [platformDir]` | Requirement × repo coverage matrix | yes (array) | 0 / 2 |
| `spec query <text> [platformDir]` | Full-text retrieval over requirements | yes (array) | 0 / 2 |
| `spec relations [platformDir]` | Mermaid graph of Relates links between requirements | yes (array) | 0 / 2 |
| `spec provenance [platformDir]` | Per-requirement provenance matrix: creating/revising issues + backing tests + git pointer | yes (array) | 0 / 2 |
| `spec resolve <files…> [platformDir]` | Requirements tagged in the given files | yes (array) | 0 / 2 |
| `spec propagation <KEY-NNN> [platformDir]` | Per-repo migrated/drifted state for a superseded req | yes (array) | 0 / 2 |
| `spec gate <repo> <KEY-NNN> [platformDir]` | Approval gate: pass iff req Active and pin covers it | yes (object) | 0 / 1 / 2 |
| `spec init [repo]` | Write a member's `spec-engine.member.json` pin | yes (object) | 0 / 2 |
| `spec domain new <KEY>` / `spec domain list` | Scaffold / list `spec-engine/<KEY>/SPEC.json` | `list`: yes (array) | 0 / 2 |
| `spec migrate [platformDir]` | Hard-cutover every canonical `SPEC.md` to a schema-validated sibling `SPEC.json`, then delete the `SPEC.md` (idempotent; skips already-migrated dirs) | no | 0 / 2 |
| `spec req <domain-prefix> [platformDir]` | Piped: print next unused ID. TTY: interactive authoring. `--text` (+`--why/--binds/--lives`): author non-interactively | yes (object) | 0 / 2 |
| `spec term <name> [platformDir]` / `spec term list` / `spec term revise <TERM-NNN>` / `spec term confirm <KEY-NNN> <TERM-NNN>` | Author a glossary TERM (definition in the statement, headword in `term`, `--aliases` synonyms), list terms, revise a definition in place with a version bump, or re-pin/re-point a requirement's citation (clears TERM_DRIFT / SUPERSEDED_TERM_REFERENCED) | yes (object/array) | 0 / 2 |
| `spec glossary [platformDir]` | GENERATE GLOSSARY.md from the TERM store (byte-stable). `--migrate`: one-time parse of GLOSSARY.md into `TERM-001..N` (idempotent-skip). `--check`: fail on drift (committed != generated) | yes (object) | 0 / 1 / 2 |
| `spec supersede <KEY-NNN> [platformDir]` | Flip to `Superseded by NEW`, mint successor, bump spec_version, emit retag worklist | yes (object) | 0 / 2 |
| `spec move <KEY-NNN> <NEW-DOMAIN> [platformDir]` | Cross-domain supersede: mint the successor in `<NEW-DOMAIN>` carrying the source's fields, flip the source to superseded, bump both specVersions, emit retag worklist | yes (object) | 0 / 2 |
| `spec amend <KEY-NNN> [platformDir]` | Revise an unshipped entry's fields in place (same id, no version bump) | yes (object) | 0 / 2 |
| `spec serve [platformDir] [--port N]` | Local webapp + `/api/*` over the index | n/a (HTTP) | 0 / 1 / 2 |
| `spec mcp [platformDir]` | MCP server over stdio: agent-native query/resolve/check/report tools | n/a (JSON-RPC) | 0 / 2 |

Common flags on the index-touching commands (`index` / `check` / `map` /
`query` / `relations` / `resolve` / `propagation` / `gate` / `serve`):
`--out <path>` (DB path override — must resolve inside `platformDir`) and
`--no-prompt`; `--json` on all of those except `serve`. `init` / `domain list` /
`req` register `--json` only (no `--out`, no `--no-prompt` — they never touch
the index); `domain new` registers none of the three.

**Index freshness.** The read commands (`map` / `query` / `relations` /
`resolve` / `propagation`) build the index transparently when it is missing
but otherwise TRUST a schema-matching existing index — if the platform
changed since the last `spec index`, their output is stale. The exceptions
rebuild cold by design: `gate` always, `check` with `--ci`. To force the
cold path on a read command, pass `--fresh` (rm db + WAL/SHM, then reindex —
same trio as `check --ci`). Agents: prefer `--fresh` when you have just
edited specs or tags and need the answer to reflect it.

### Per-command notes

- **`spec index`** — stdout `--json` shape: `{ build_id, repos, domains,
  requirements, tags, diagnostics }`. `build_id` is deterministic for identical
  inputs (cold rebuild equivalence). Exit 1 = crash mid-index, exit 2 = not a
  platform / bad args.
- **`spec check`** — diagnostics sorted deterministically; severity `error`
  drives exit 1, `warning` alone exits 0. `--ci` deletes the DB first (cold
  rebuild — correctness never trusts a warm index). JSON rows:
  `{ code, severity, repo, source_file, line, req_id, detail }` (nullable
  except `code`/`severity`/`detail`). Codes: `DUP_ID`, `BROKEN_SUPERSEDE`,
  `CYCLIC_SUPERSEDE`, `DANGLING_TAG`, `BAD_STATUS`, `DRIFT`,
  `SUPERSEDED_REFERENCED`, `ORPHAN_REQ`, `UNVERIFIED_REQ`,
  `NO_SPEC_CONFIG`, `BROKEN_FILE_REF`, `BROKEN_RELATES`,
  `RELATES_SUPERSEDED`, `SELF_RELATES`, `UNDEFINED_TERM`,
  `ORPHAN_TERM`, `TERM_DRIFT`, `SUPERSEDED_TERM_REFERENCED`. The four
  term-store codes (Phase 6): `UNDEFINED_TERM`
  (**error** — a requirement's `cites` entry resolves to no TERM, so it
  gates `--ci`) and `ORPHAN_TERM` (**warning** — an Active TERM entry that
  no requirement cites; glossary rot, non-fatal so a freshly-migrated term
  never reds the gate); plus the two citation-drift codes — `TERM_DRIFT`
  (**warning** — a requirement's `cites` pin lags the cited term's current
  version after an in-place `spec term revise` version-bump; a
  re-confirmation prompt, not a build-breaker, so it never reds the gate)
  and `SUPERSEDED_TERM_REFERENCED` (**error** — a citation to a superseded
  term id after `spec supersede TERM-NNN`, the SUPERSEDED_REFERENCED analogue
  one level up, so it gates `--ci`). Both clear via `spec term confirm`; the
  drift predicate (`term.changed_at_version > citation.pinned`) lives in the
  ONE `term_drift` VIEW, cloned from the member-pin `drift` VIEW.
  - **trusted-red (`--results <junit.xml>`)** — pass your test runner's JUnit
    XML and `check` enforces proof-of-passing: an active requirement is
    `PROVEN` only with ≥1 **passing** verifying tag; a tag on a failing or
    missing test surfaces `UNPROVEN_REQ` and (under `--ci`) exits 1. Without
    `--results`, `check` emits `PROOFS_UNCONFIRMED` (stderr) and skips proof
    enforcement — the bare gate stays structural. The results file is
    decoration ingested AFTER the derived index and is NEVER hashed into
    `build_id`, so `--results` cannot change cold-build correctness. Generate
    with `bun test --reporter=junit --reporter-outfile=.spec-engine/results.xml`
    then `spec check . --ci --results .spec-engine/results.xml`. Keep the results
    path inside `platformDir` (it resolves relative to it); `.spec-engine/` is
    git-ignored.
- **`spec guard`** — the pre-commit loss gate. Diffs the requirement
  derivation at `--against <ref>` (default `HEAD`) against the working tree
  and reports what the change is about to lose, scoped cheaply to the files
  in `git diff <ref>`. The worktree index is rebuilt cold every run (like
  `check --ci`), so the answer always reflects the current tree. JSON rows:
  `{ kind, req_id, file, line, detail }`, sorted by `(req_id, kind, file,
  line)` and byte-stable. `kind` ∈ `REQUIREMENT_REMOVED` (an Active req absent from
  the worktree spec with no approved supersession) | `IMPL_LOST` (the last
  implementing tag for a surviving Active req removed) | `VERIFY_LOST` (its
  last verifying tag removed) | `SPEC_FILE_DELETED` (`req_id` null — a
  canonical spec file gone). Exit 1 on any loss, 0 clean. **A loss is
  suppressed** two ways: superseding the requirement in the same change
  (either direction), or an explicit `// @spec approve KEY-NNN <reason>`
  comment in the change (mandatory reason — same UX as `biome-ignore`). Text
  mode emits the product-surface `🛑 spec-guard:` block per requirement,
  written in the second person so an agent relays it verbatim.
  **Never-fail-non-git (GUARD-008):** a non-git tree, a fresh repo with no
  `HEAD`, or an unfetched/misspelled ref prints a `NOT_A_GIT_REPO` warning to
  stderr and exits 0 — the guard is a safety net, not a git dependency.
- **`spec map`** — JSON rows keyed `(req_id, repo)`:
  `{ req_id, domain_key, req_status, req_spec_version, req_changed_at_version,
  repo, repo_pin, implemented: 0|1, verified: 0|1, test_levels }`. Text mode
  renders the matrix (`src`, `test`, `src+test`, `—`).
- **`spec query`** — FTS5 `MATCH` syntax. Wrap multi-word phrases in double
  quotes inside the shell-quoted arg; bare `AND OR` is an FTS5 grammar error
  (exit 2). `--limit N` (default 10, max 1000). Results are rank-ascending
  (best first); superseded requirements are excluded. **Glossary term
  definitions surface too:** terms are rows in the reserved `TERM` domain that
  ride the same FTS index (the query matches a term's DEFINITION, not its
  headword), so a matching term appears in a separate **Terms** group beside
  the **Requirements** table (text mode), discriminated by the `key` field on
  each hit (`--json`). Terms stay IN query but OUT of `spec map` / coverage —
  the `key != 'TERM'` exclusion lives on the coverage view, never on FTS.
- **`spec relations`** — text mode emits mermaid `graph LR` source: one
  node per requirement id appearing in a `**Relates:**` field (original id
  as the bracket label), one undirected deduped edge per linked pair —
  paste into any mermaid renderer or fenced ` ```mermaid ` block. `--json`
  rows: `{ from_id, to_id, source_file, line }`, sorted by (from, to).
  Broken targets still render as nodes (the index keeps them); run
  `spec check` for the `BROKEN_RELATES` / `RELATES_SUPERSEDED`
  diagnostics. Empty graph: `[]` + exit 0 (guidance on stderr in text mode).
- **`spec provenance`** — text mode renders, per requirement, its provenance
  links: the creating issue (`created`), the revising/retiring issues
  (`supersedes-via` / `amends-via`), the backing tests, and the git pointer
  (`source_file:line`). The issue id is opaque — printed verbatim, never
  resolved against requirements. `--json` rows:
  `{ req_id, role, issue_id, source_file, line, req_status, implemented,
  verified, test_levels }`, sorted on the full composite key (req_id, role,
  issue_id, source_file, line) for byte-stable output. Empty matrix: `[]` +
  exit 0 (guidance on stderr in text mode).
- **`spec resolve`** — accepts multiple positionals, comma-split inside one
  positional (`a.ts,b.ts`), and absolute paths under the platform dir. See
  path rules below. Empty result is `[]` + exit 0, not an error.
  **Reverse query:** `--req KEY-NNN` inverts the mapping — every tag site
  for that requirement across all repos. JSON rows:
  `{ req_id, repo, file, line, kind, level }` sorted by (repo, file, line);
  `kind` ∈ `implements` | `verifies` | `documents`, `level` nullable.
  Takes no file positionals (at most a platform dir). Unknown id → `[]` +
  guidance on stderr, exit 0; a dangling-tagged id still lists its sites.
- **`spec propagation`** — one row per member repo:
  `{ repo, state, via_req_id, drifted }` with `state` ∈ `MIGRATED_VERIFIED` |
  `MIGRATED_UNVERIFIED` | `ON_PREDECESSOR` | `ON_OTHER_DOMAIN_REQ` |
  `NO_DOMAIN_REFERENCE`.
- **`spec gate`** — JSON: `{ pass, reason, repo, req_id, detail, status,
  changed_at_version, pinned_spec_version }` with `reason` ∈ `PASS` |
  `NOT_FOUND` | `DRAFT` | `SUPERSEDED` | `VERSION_PIN`. Decision order:
  NOT_FOUND → DRAFT → SUPERSEDED → VERSION_PIN → PASS; pin equality passes.
  An unknown repo name is a usage error (exit 2), not a gate failure.
- **`spec req`** — when stdin is **not** a TTY it prints the bare next unused
  ID (e.g. `BILLING-010`) and exits 0 — zero prompts, zero writes. Domain
  prefix is case-insensitive (`bil` → `BILLING`; ambiguous prefix → exit 2).
  `--json` prints `{ domain, next_id }` instead and forces the same
  zero-prompt / zero-write id query even on a TTY.
  **Non-interactive authoring:** `--text "<requirement>"` appends the entry
  with zero prompts (TTY or not); `--why` / `--binds` / `--lives` fill the
  other fields (default empty; they error without `--text`). With `--json`
  the write confirms as `{ id, file }`. Unresolvable `@<path>` refs warn on
  stderr and never block.
- **`spec term`** — the glossary-term authoring surface. A term IS a
  requirement row (reuse, not a parallel schema): the definition lives in the
  `statement` field, the headword in `term`, its synonyms in `aliases`.
  **Author:** `spec term "<name>" --def "<definition>" [--aliases a,b]
  [--section s] [platformDir]` appends a `TERM-NNN` entry through the single
  `validateAndWrite` seam; `--json` confirms as `{ id, file }`. With NO
  `--def`/`--text` the command is a pure id query (mirror `spec req`'s non-TTY
  contract): the bare next unused `TERM` id on stdout (or `{ domain, next_id }`
  under `--json`), zero writes. **`spec term list`** reads the filesystem (never
  the index) and prints each entry's `id  name  status` sorted by id, or a
  `[{ id, term, status }]` array under `--json`. **`spec term revise
  <TERM-NNN> --def "<definition>"`** is the one op requirements do NOT have —
  it rewrites the definition IN PLACE (same id) and bumps the envelope
  `specVersion` (+ the entry's `changedAtVersion`), the pin every citing
  requirement drifts against; `--no-bump` opts out, `--json` emits
  `{ id, file, spec_version }`. **`spec term confirm <KEY-NNN> <TERM-NNN>
  [platformDir]`** re-pins a requirement's citation to the cited term's current
  `specVersion`, clearing `TERM_DRIFT`; when the cited term is Superseded it
  RE-POINTS the citation to the successor id, clearing
  `SUPERSEDED_TERM_REFERENCED`. Writes the citing domain ONCE through
  `validateAndWrite` then reindexes fresh; `--json` emits
  `{ req_id, term_id, pinned, file }`. **Lifecycle:** `spec supersede TERM-NNN` and
  `spec amend TERM-NNN` operate on TERM ids exactly as on requirements — the
  supersede successor carries the predecessor's `term`/`aliases` forward
  (`--term`/`--aliases` override), and `spec amend --term`/`--aliases` revise a
  term's headword/synonyms in place. Exit codes 0 / 2.
- **`spec glossary`** — the GLOSSARY.md round-trip (TERM-06). The repo's own
  GLOSSARY.md is migrated ONCE into the TERM store, then GENERATED back from it so
  the human view can't silently drift from the canonical terms. **Generate**
  (`spec glossary [platformDir]`, the default): reads the TERM store and
  OVERWRITES GLOSSARY.md deterministically — a fixed `# Glossary` header + intro,
  terms walked in id order, each `## {section}` heading emitted once when it
  changes, then a `- **{term}** — {statement}` bullet per term, single trailing
  newline. LLM-free, no Date/random, so two runs are byte-identical (it is NOT
  part of `spec index` — index stays read-only-to-source). **Migrate**
  (`--migrate`): parses each `- **Name** — def` bullet (multi-line collapsed) into
  a `TERM-NNN` entry in document order, carrying the enclosing `## Section` in the
  `section` field, written through the single `validateAndWrite` seam; idempotent
  — skips when the TERM domain already holds entries. **Check** (`--check`):
  regenerates into a buffer and diffs byte-for-byte against the committed
  GLOSSARY.md — exit 1 on any drift, 0 clean; this is what
  `fence_glossary_roundtrip` (scripts/arch-fences.sh) shells out to. `--json`
  emits `{ migrated }` / `{ generated }` / `{ ok }` respectively. The ~30
  migrated terms are uncited, so they surface as `ORPHAN_TERM` WARNINGS — `spec
  check --ci` stays exit 0. Exit codes 0 / 1 / 2.
- **`spec domain list`** — `--json` prints one sorted array of `{ key, scope }`
  objects (scope: the per-domain charter sentence, `null` when the domain has
  none; `[]` when there are no domains, still exit 0) — read from each
  `SPEC.json` on the filesystem, never the index. Text mode is one key per line
  (keys only, unchanged).
- **`spec supersede`** — the post-ship lifecycle move. Requires the target
  to be `Active` (already-superseded / Draft / Retired → exit 2 with
  guidance). Successor fields: `--text` is the new Requirement (mandatory
  non-TTY; prompted on a TTY); `--why` / `--binds` / `--lives` default to
  COPIES of the old entry's values. Reindexes fresh, then emits the retag
  worklist — every tag site still on the old id (the same sites `check`
  reports as `SUPERSEDED_REFERENCED` until retagged). `--json`:
  `{ old_id, new_id, file, spec_version, retag: [{ req_id, repo, file,
  line, kind, level }] }`. On a requirement (non-TERM) domain `spec_version`
  is the **DAG-derived** domain version after this supersession — no authored
  counter is written (SCHM-008), the new `supersededAtVersion` died-at stamp is
  that same derived number (REQ-016), and `--no-bump` is a no-op (there is no
  counter to hold back). On the reserved TERM domain the authored `specVersion`
  still bumps (+1) — its counter is the term-drift pin — and `--no-bump` opts
  out (then `spec_version` is null). Always advances `updated`. All guards run
  before the first byte is written.
- **`spec move`** — the cross-domain counterpart of `spec supersede`, for
  taxonomy reorganization. Mints the successor as the next unused id in
  `<NEW-DOMAIN>` (which must already exist — `spec domain new` it first),
  copying the source's `statement` / `why` / `livesIn`; `--text` / `--why` /
  `--lives` override so a non-standalone requirement can be rewritten AS it
  moves. Flips the source to `superseded` with a cross-domain `supersededBy`
  (the schema and index resolve it globally), advances both envelopes'
  `updated`, reindexes fresh, and
  emits the retag worklist (the sites `spec check` flags as
  `SUPERSEDED_REFERENCED` until retagged). Only Active requirements move
  (superseded/retired stay as history); moving to the source's own domain is a
  usage error (use `spec supersede`). All guards run before the first write, and
  both envelopes are validated before EITHER is written, so a reject never
  leaves a half-applied move. `--json`: `{ old_id, new_id, from_file, to_file,
  source_spec_version, target_spec_version, retag: [...] }`. For requirement
  (non-TERM) domains both versions are **DAG-derived**: the source gains a
  supersede edge so its version advances, while the target gains only an Active
  successor (no edge) so its version is UNCHANGED (REQ-016); `--no-bump` is a
  no-op there. A TERM side keeps its authored `specVersion` bump and honors
  `--no-bump` (then that side's version is null).
- **`spec amend`** — the pre-production counterpart to supersede. Field
  flags (`--text` / `--why` / `--binds` / `--lives`) name what changes; at
  least one is required, untouched fields stay byte-identical. Only Active
  and Draft entries amend (superseded/retired → exit 2). Bumps frontmatter
  `updated`, never `spec_version`. `--json`: `{ id, file, fields_changed }`.
- **`spec init`** — an existing `spec-engine.member.json` is left untouched and
  reported as "already configured" with **exit 0** (a no-op, not a refusal) —
  do not use the exit code to distinguish "wrote" from "already there".
  `--force` rewrites it; `--specs spec-engine@N` overrides the pin. Default pin
  resolution (INIT-013): `--specs` wins, else the DERIVED platform version (max
  domain version across the enclosing platform's `spec-engine/*/SPEC.json`),
  else `spec-engine@1` with a printed note when no platform is found upward. The config
  may carry an optional `ignore: ["dir", …]` array (repo-relative directory
  prefixes excluded from that repo's tag/doc scans, additive to the built-in
  ignore list); `--force` preserves it. It may also carry an optional
  `members: "<glob>"` (monorepo expansion): instead of registering the config's
  own directory as a single member, discovery expands each subdirectory
  matching the glob (relative to the config) into its OWN member — one coverage
  column per workspace package, each inheriting the parent pin unless it carries
  its own nested `spec-engine.member.json`. This repo dogfoods it:
  `packages/spec-engine.member.json` sets `"members": "*"`, so engine/shared/
  tracker/webapp each get a `packages/<pkg>` column. `--json`
  prints one object: `{ action: "wrote", path, pin, source }` or
  `{ action: "already-configured", path, pin, extra_fields }` (`extra_fields`
  lists keys beyond `specs`; in text mode those surface as a warning line).
  Errors stay text-on-stderr + exit 2 in both modes — branch on `action`.
- **`spec serve`** — binds loopback only. `--probe` boots on an ephemeral
  port, fetches `/` and checks the placeholder page renders, then exits
  (0 OK / 1 failed). API routes:
  `/api/coverage`, `/api/report` (per-domain rollup over Active reqs:
  `{ domain, active, implemented, verified, orphans, unverified }`),
  `/api/requirements[/:id]`, `/api/propagation/:id`,
  `/api/query?q=&limit=`, `/api/resolve?files=…&files=…`,
  `/api/relations[?format=mermaid]` (mirror of the CLI contracts; 400 on
  bad input, never 500 for FTS5 syntax). SSR pages: `/` (coverage matrix,
  carrying the platform-health stats + per-member heat chips on domain
  rows — the retired `/report` page's visuals live here now),
  `/requirements[/:id]`, `/query`, `/propagation/:id`, `/relations`.

- **`spec mcp`** — the agent-native front-end: an MCP (Model Context
  Protocol) server over stdio. Register in the harness (e.g. `.mcp.json`:
  `{ "command": "spec", "args": ["mcp", "<platformDir>"] }`) and call
  tools instead of shelling out. Tools: `spec_query` (FTS retrieval),
  `spec_resolve` (files → requirements), `spec_req_tags` (requirement →
  tag sites), `spec_coverage_report` (per-domain rollup), `spec_check`
  (diagnostics), `spec_propagation` (per-repo migration state),
  `spec_next_id` (id allocation preview). Results are the same JSON the
  CLI's `--json` modes emit. EVERY tool call reindexes fresh — the server
  is long-lived and you edit specs/tags between calls, so it never serves
  a stale answer. stdout is the protocol channel; all chrome is stderr.
  It also advertises one MCP **prompt**, `author_requirements` (args `brief`
  required + `domain` optional): `prompts/get` returns a static authoring
  playbook with the brief substituted and, when a domain is given, that
  domain's charter/scope injected — a template only, the engine runs no
  model (the client's model consumes it; `fence_llmfree_engine` keeps the
  engine LLM-free).

## Authoring requirements (brief → mint)

The mint front-half of the lifecycle: how a vague brief/ticket becomes
well-formed requirements the route → tag → check loop below then consumes. This
section owns the operational CLI choreography only — the authoring RUBRIC lives
once in `spec-engine/TAXONOMY.md` §4.10 (the eight-point standard); cross-
reference it, never restate it here.

1. **Fan out the brief** — one requirement per **testable promise**, NEVER one
   per ticket. A single issue's acceptance criteria typically become several
   durable `KEY-NNN` requirements.
2. **Place each** — `spec domain list --json` prints every domain's scope;
   concept-wins per the domain charter (`spec req <domain>` alone prints the
   target charter — CHRT-005 — confirming placement before you write).
3. **Dedup** — `spec query "<phrase>" . --json` BEFORE minting; overlap →
   `spec amend`/relate the existing requirement, not a new id.
4. **Draft + self-check** — write each statement to the GUARD template and run
   the cold-read rubric: see `spec-engine/TAXONOMY.md` §4.10 for the eight-point
   authoring standard (subject named, cold-read-standalone, timeless, the `why`
   carries the failure mode). Do NOT copy those eight points here — three copies
   drift; §4.10 is the single source.
5. **Mint** — `spec req <domain> --text "<statement>" --why "<failure mode>" --lives "<file>"`
   appends a born-active requirement, allocating the next unused id in the domain.
6. **Provenance, not identity** — the originating ticket is recorded as `Issues:`
   provenance ONLY: never a requirement id, never a code `@spec` tag (the issue
   is an ephemeral work event; the `KEY-NNN` is the durable unit).
7. **Verify** — `spec index . && spec check . --ci` (exit 0, no ORPHAN/UNVERIFIED)
   and `spec guard .` (no loss) before opening the PR.

## The agent loop (route → tag → check)

Before changing code, load the requirements the task touches:

```
spec query "renewal charge" . --json          # by topic → ranked hits with req ids
spec resolve src/billing/renew.ts . --json    # by file → requirements bound to it
```

While implementing, bind new code to its requirement:

```ts
export function renew() { /* … */ }     // @spec BILLING-009
it("charges current price", () => {})   // @spec BILLING-009 unit
```

Before finishing, allocate IDs / author additions and verify integrity:

```
echo | spec req bil                    # next unused BILLING id (piped = no prompts)
spec index . --json                    # rebuild the derived index
spec check . --ci --json               # exit 1 ⇒ an error diagnostic; fix before PR
spec guard . --json                    # exit 1 ⇒ this change deletes a live requirement
```

When `spec guard` blocks you, report to the user exactly which requirement was
protected and why (relay the `🛑 spec-guard:` block verbatim) before proceeding —
then either `spec supersede` it with a successor or get the user's explicit
decision to retire it. Never silently delete a requirement to make the gate pass.

## Path rules for `spec resolve`

`tags.file` is stored platform-relative as `<repo>/<path>`:

- **Multi-repo platform**: pass `<repo>/<path>` — e.g.
  `spec resolve api/src/renew.ts .`
- **Single-repo / rung-1 (self-member)**: both forms are accepted —
  the natural repo-relative path (`spec resolve src/orders.ts .`) and the
  basename-prefixed form (`spec resolve my-repo/src/orders.ts .`). Prefer the
  natural form.
- Absolute paths are normalized against `platformDir`; any path that resolves
  outside it exits 2 (never a silent `[]`).

## Gotchas

- **`fixtures/` is globally ignored by the tag scanner** — `@spec` tags under
  any `fixtures/` folder never index. Planted fixture defects are test data;
  do not "fix" them to make `spec check` pass.
- **The DB owns nothing.** Never edit `.spec-engine/index.sqlite`; edit the
  `SPEC.md` source and re-run `spec index`. Deleting `.spec-engine/` is always safe.
- **`storage_unavailable` / `SQLITE_IOERR*` means your environment, not the
  data.** The index DB runs in WAL mode and needs real file locks. A sandboxed
  process (e.g. a coding agent's default seatbelt profile on macOS) gets
  `SQLITE_IOERR_VNODE` on every query — the CLI exits 1 with a hint naming
  this, and `/api/*` returns a structured 503 `{error: "storage_unavailable",
  code, hint}`. Fix: re-run the command unsandboxed (or grant the sandbox
  write+lock access to `<platformDir>/.spec-engine/`). `SQLITE_BUSY` instead
  means another `spec` process holds the DB — retry after it finishes.
- **Empty ≠ error.** Read commands exit 0 with `[]` and put first-spec guidance
  on stderr when the platform has no requirements yet.
- **Determinism is contractual.** JSON outputs are deterministically sorted and
  byte-stable across runs — safe to diff/snapshot.
- A directory passed as the last positional is treated as `platformDir` only if
  it contains `spec-engine/`; otherwise it is treated as a file and a warning
  goes to stderr (disambiguate with an explicit trailing platform dir).
