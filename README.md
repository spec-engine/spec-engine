# spec-check

**Catch cross-repo spec drift in one local command.**

`spec-check` walks a whole platform — a canonical `spec-engine/` spec repo plus every
member repo that pins it — and tells you, across all of them at once, who shipped a
requirement, who verified it, and who's still stuck on a superseded version. It's the
view a single-repo file scan can't give you.

```console
$ spec propagation BILLING-009 ./platform
REPO    STATE                VIA          DRIFT?
admin   ON_OTHER_DOMAIN_REQ  BILLING-007  no
api     MIGRATED_VERIFIED    —            no
mobile  ON_PREDECESSOR       BILLING-001  yes     ← drifted: still on the superseded req
```

`BILLING-009` shipped. `api` migrated and proved it. `admin` doesn't use it. `mobile`
is still pinned to `BILLING-001`, the requirement `BILLING-009` replaced — **drift**,
found in one command instead of three repo reviews and a Slack thread.

---

## 30 seconds to value

No global install yet (PoC). From a checkout:

```bash
bun install
alias spec="bun packages/engine/src/cli.ts"     # or: bun build --compile packages/engine/src/cli.ts --outfile=dist/spec
```

The repo ships `fixtures/platform-fixture` — a canonical `spec-engine/` and three
member repos (`admin`, `api`, `mobile`) — with drift deliberately planted. Run:

**1. The coverage matrix** — every requirement × every repo:

```console
$ spec map fixtures/platform-fixture
DOMAIN   REQUIREMENT  STATUS      admin     api       mobile  spec-engine
AUTH     AUTH-001     Active      —         —         —       —
BILLING  BILLING-001  Superseded  —         —         src     —
BILLING  BILLING-002  Active      —         src       —       —
BILLING  BILLING-007  Active      src+test  src+test  src     —
BILLING  BILLING-009  Active      —         src+test  —       —
```

Each cell: `src` (implemented), `test` (verified), `src+test` (both), `—` (nothing).

**2. Integrity** — dangling tags, drift, orphans, superseded references:

```console
$ spec check fixtures/platform-fixture
DANGLING_TAG          admin   admin/src/reports.ts:2   BILLING-999  references non-existent requirement
DRIFT                 mobile  mobile/src/billing.ts:1  BILLING-001  pinned @1, requirement changed at @2
SUPERSEDED_REFERENCED mobile  mobile/src/billing.ts:1  BILLING-001  superseded by BILLING-009
ORPHAN_REQ                    spec-engine/AUTH/SPEC.json:8  AUTH-001  active requirement, no implementing tag
UNVERIFIED_REQ                spec-engine/BILLING/SPEC.json  BILLING-002  implemented but never verified
```

That's the whole loop: **write specs, tag code, check the platform.**

---

## How it works

Three moving parts, and the important one owns nothing:

1. **Canonical specs** live in a `spec-engine/` repo as `spec-engine/<DOMAIN>/SPEC.json`.
   Each requirement is a durable id — `BILLING-009` — with a status (`Active`,
   `Superseded by …`). This is the only source of truth.
2. **Code points back** with a `@spec` tag: `// @spec BILLING-009` in a source file
   (implements it), `// @spec BILLING-009 verifies` in a test (proves it).
3. **A derived index** (`.spec-engine/`, a disposable `bun:sqlite` db) is built from 1 + 2.
   Delete it and rebuild — you get a byte-identical result. Coverage is a SQL **view**
   over the tags, so it can never drift from what the tags actually say.

Member repos pin a version in `spec-engine.member.json` (`{ "specs": "spec-engine@1" }`) —
one platform-wide scalar compared, per requirement the repo references, against the
version at which that requirement last changed (derived locally within its own domain).
Nobody authors these numbers: a domain's version is **derived** from its supersede history,
so it advances exactly when a requirement is superseded and can only ever move forward.
Supersede `BILLING-001`, the domain derives to `@2`, and every member still pinned at `@1`
lights up as drift — the cross-repo loop this tool exists to prove. Because the version is
read from the supersede graph rather than a counter someone maintains, it cannot be
hand-edited into disagreeing with what actually happened. The platform version is derived
the same way — the max across domains, what `spec init` writes as a fresh member's default
pin; there is no authored platform counter. A sibling directory that exists
but never opts in (no `spec-engine.member.json`) surfaces as a `NO_SPEC_CONFIG` warning
rather than silently vanishing from the platform view.

`SPEC.json` is the sole spec format — a one-time `spec migrate` performed the JSON
cutover from the legacy Markdown specs, so every read and write surface now shares one
schema.

## Commands

| Command | What it does |
|---|---|
| `spec map <dir>` | Platform-wide coverage matrix (requirement × repo) |
| `spec check <dir>` | Integrity + drift diagnostics; `--ci` for a cold, gate-able run |
| `spec guard <dir>` | Loss detection: block a change that deletes a requirement, its last tag, or its test without superseding |
| `spec propagation <REQID> <dir>` | Per-member migration state for one requirement |
| `spec query <text> <dir>` | Full-text search across requirements |
| `spec resolve <files…>` | Map changed files → the requirements they touch |
| `spec req` / `spec supersede` / `spec amend` | Author and evolve requirements |
| `spec init <repo>` | Scaffold `spec-engine.member.json` into a member |
| `spec gate` / `spec relations` / `spec provenance` | Approval gate, cross-refs, provenance |
| `spec serve <dir>` | Local read-only webapp for the matrix and detail views |
| `spec mcp` | Expose the engine to agents over MCP |

Run any command with `--help` for full flags. `--json` on the read commands emits
deterministic, chrome-free output for scripting.

## Local webapp

`spec serve <dir>` runs a local web UI over the derived index — the coverage matrix and
the detail views, rendered server-side:

```console
$ spec serve . --port 4319
spec: serving on http://127.0.0.1:4319
```

`--port 0` (the default) picks an ephemeral port; pass a fixed port for a stable URL.
The pages: `/` (coverage matrix), `/report` (per-domain rollup + spec chart),
`/requirements` and `/requirements/:id`, `/query` (full-text search — term definitions
render beside requirement hits), `/relations`, `/propagation/:id`, `/provenance`. The
same routes are available as JSON under `/api/*` (`/api/coverage`, `/api/report`,
`/api/requirements[/:id]`, `/api/query?q=`, `/api/resolve?files=…`, `/api/relations`,
`/api/propagation/:id`). The webapp reads the index; run `spec index . --fresh` after
editing specs or tags so the UI reflects the change.

### Access model — there is no login or API key

The webapp has **no password, bearer token, or session** — and it does not need one.
Access is gated by *where the request comes from*, in three layers:

1. **Loopback-only bind.** The server binds `127.0.0.1` and nothing else. There is no
   `--host` flag by design, so it is never reachable from another machine. To use it
   remotely, forward the port over SSH (`ssh -L 4319:127.0.0.1:4319 you@host`) — the tunnel
   endpoint stays loopback on both ends.
2. **Host-header pin (anti-DNS-rebinding).** A request whose own `Host` header is not a
   loopback name is rejected, so a malicious web page that rebinds its DNS to `127.0.0.1`
   cannot drive your local server.
3. **Same-origin guard on write routes.** The editor's POST routes reject a cross-origin
   `Origin` (a drive-by page cannot auto-submit to your local instance); read routes are
   open to anything that can already reach loopback — i.e. only you, on this machine.

So the "auth" is: be on the same machine (or an SSH tunnel to it), and same-origin for
writes. There is deliberately no shareable secret to expose it publicly.

### The one secret — `SPEC_TRACKER_TOKEN` (tracker provenance, *not* webapp auth)

The only header secret in the system is unrelated to reaching the webapp: it authenticates
`spec-check` to your **issue tracker** so `spec provenance` (and the webapp's provenance
view) can resolve an issue id like `ENG-1234` into its title/state/URL. Set it in the
environment before serving:

```bash
export SPEC_TRACKER_TOKEN="<your-Linear-API-key>"
spec serve . --port 4319
```

- It is read once from `process.env.SPEC_TRACKER_TOKEN` and sent as a **raw `Authorization`
  header** (no `Bearer ` prefix — a Linear quirk) to `https://api.linear.app/graphql`,
  as a **read-only** GraphQL query. It is never written to a log.
- **It is optional.** With no token, provenance degrades gracefully to the bare opaque
  issue ids plus a "set `SPEC_TRACKER_TOKEN`" hint — every other page works unchanged.
- Issue ids are provenance annotations only; the engine never treats them as identity or
  routing, so a missing/invalid token never affects coverage, drift, or the gate.

## CI gate

`spec check <dir> --ci` builds a fresh index from scratch (never trusting a warm one)
and exits non-zero when the platform has unresolved drift or integrity problems. Feed
it your test results with `--results` to arm the **trusted-red** gate — an Active
requirement counts as proven only when it has a *passing* verifying test, so a tag on a
red or missing test fails the build:

```bash
bun test --reporter=junit --reporter-outfile=.spec-engine/results.xml
spec check . --ci --results .spec-engine/results.xml
```

## Loss guard

`spec check` sees the world as it *is* — the derived index has no memory, so a change
that deletes an Active requirement together with its `@spec` tags and its tests rebuilds
into an index that is simply consistent-but-smaller, and nothing alarms. `spec guard`
gives it a memory: it diffs the requirement derivation at a git ref (default `HEAD`)
against your working tree and blocks what's about to be lost.

```console
$ spec guard .
🛑 spec-guard: BILLING-009 is Active and this change deletes its only implementation
(src/billing.ts:12) and its verifying test. Requirements are superseded, never deleted.
Either run `spec supersede BILLING-009` with a successor, or stop and ask the user
whether this requirement should die.
```

It exits `1` on any loss, `0` when clean (or when run outside a git repo — it never fails
a non-git context). Two things suppress a loss: superseding the requirement in the same
change (the legal path), or an explicit `// @spec approve BILLING-009 <reason>` comment —
the deliberate, reasoned escape hatch, same UX as `biome-ignore`.

Wire it as a **pre-commit hook** (lefthook shown; a bare `.git/hooks/pre-commit` works too):

```yaml
# lefthook.yml
pre-commit:
  commands:
    spec-guard:
      run: bun packages/engine/src/cli.ts guard . || exit 1
```

…or as a **Claude Code `PostToolUse` hook** so a coding agent is stopped the moment its
edit would steamroll a requirement:

```jsonc
// .claude/settings.json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "spec guard ." }] }
    ]
  }
}
```

## For agents

`spec-check` is built to be driven by coding agents. See **[AGENTS.md](AGENTS.md)**
for the machine-facing reference: the route → tag → check loop, exit-code contract, and
`--json` schemas. `spec mcp` exposes the same engine over the Model Context Protocol.

## Status

This is a proof-of-concept. It runs locally on [Bun](https://bun.com) with zero native
deps; the spec format and command surface are pre-1.0 and may change.

**Supported platforms: macOS and Linux.** The scanner matches `/`-separated paths, so
Windows is not yet supported (paths would misclassify and break the byte-equality joins
the derived index relies on). CI runs on `macos-14` (Apple Silicon) and `ubuntu-latest`.

## License

MIT — see [LICENSE](LICENSE).
