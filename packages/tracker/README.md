# @spec-engine/tracker

Read-only bridge from requirement provenance to external issue trackers (Linear today).

## What it does

- Resolves opaque issue ids stored in a requirement's provenance (e.g. `ENG-1234`) into live metadata: title, status, url.
- Powers the `spec provenance` command and the webapp's provenance and editor pages.
- Never creates the link. The id already lives on the requirement; this package only enriches it.

## Design contracts

- **Never throws** (TRK-05): `resolveIssues` always resolves to a `Map` of results. A dead network, bad token, or malformed response becomes a typed `reason`, never an exception. A tracker outage cannot break a `spec` command.
- **Read-only** (TRK-04): reqs to Linear, lookup only. Sends a GraphQL `query`, never a write. Req state is never pushed back.
- **Cache owns nothing** (TRK-07): resolved metadata is stored in a deletable JSON sidecar at `.spec-engine/tracker-cache.json`, a sibling of the sqlite index, never a table inside it. It is excluded from the index `build_id`, so `spec check --ci` stays byte-identical whether the tracker is reachable or the cache is warm, cold, or corrupt.
- **Import fence**: types live here (not in `@spec-engine/shared`) so only `provenance/resolve.ts` and `commands/provenance.ts` in the engine touch the adapter surface.

## Modules

| File | Role |
|------|------|
| `types.ts` | The contract: `TrackerMeta` (title/status/url) and the no-throw `TrackerResult` union (`{ok:true, value}` or `{ok:false, reason}`). |
| `adapter.ts` | Generic `TrackerAdapter` interface, plus `noopAdapter`, the offline default that degrades every id to `absent` with zero network and zero env reads. |
| `linear.ts` | The one concrete adapter. Claims `ENG-NNNN` ids, reads the token once from `SPEC_TRACKER_TOKEN`, 5s timeout, maps every failure onto the `{ok:false}` arm. |
| `cache.ts` | The deletable JSON sidecar. Read and write are both no-throw and best-effort; only successful resolves are persisted. |
| `index.ts` | Barrel export. |

## Adapter model

- `TrackerAdapter` is a generic interface, so a second tracker (Jira, GitHub Issues) drops in without contract changes.
- `linearAdapter` is the implemented one; `noopAdapter` is the offline fallback.
- A `reason` is one of a fixed union: `absent`, `offline`, `unauthorized`, `rate_limited`, `not_found`, `timeout`, `malformed`. No server detail or token ever leaks into it.

## How the engine wires it in

`packages/engine/src/provenance/resolve.ts` runs the lifecycle:

```
readCache -> adapter.resolveIssues (no-throw) -> mergeResolved -> writeCache (best-effort, sidecar only)
```

Members: `server/api.ts`, `commands/provenance.ts`, and the webapp provenance and editor pages.

## Auth

- Token read once per `resolveIssues` call from `SPEC_TRACKER_TOKEN`.
- Sent as a raw `Authorization` header with no scheme prefix (a Linear personal-key gotcha).
- Never logged, never returned in a reason, never thrown. A missing or whitespace-only token short-circuits every id to `unauthorized` with no network call.

## Tests

- `noop-offline.test.ts`: the offline default.
- `linear-degraded.test.ts`: every failure reason via an injected `fetchImpl` stub (no real network).
- `cache-sidecar.test.ts`: the derived-not-index invariant.
