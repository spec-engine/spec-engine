# @spec-engine/webapp

The local web UI over the derived index. A Hono app of server-rendered pages,
served by the engine behind `spec serve <dir>`. Not a standalone deployment.

## Pages

| Route | Page | Status |
|-------|------|--------|
| `GET /` | Coverage matrix (requirement × repo) with the per-domain rollup | Always on |
| `GET /requirements` | Requirement browser | Always on |
| `GET /requirements/:id` | Requirement detail | Always on |
| `GET /propagation/:id` | Per-member propagation view | Always on |
| `GET /setup` | First-run guidance for an empty platform | Always on |
| `GET /query?q=...` | Full-text search | `SPEC_FLAGS=query` |
| `GET /relations` | Relates diagram | `SPEC_FLAGS=relations` |
| `GET /provenance` | Tracker provenance | `SPEC_FLAGS=provenance` |
| `GET /editor`, `POST /editor/create`, `POST /editor/amend` | Thin editor over the engine's write routes | `SPEC_FLAGS=editor` |
| `GET /glossary`, `GET /logs` | Placeholders | `SPEC_FLAGS=glossary`, `SPEC_FLAGS=logs` |

An off feature shows "coming soon" in the nav and serves a placeholder page.
`nav.ts` is the shared nav fragment mounted on every page.

## Constraints (enforced by `test/import-fence.test.ts`)

- No `bun:sqlite`, `node:fs`, `fs`, `bun`, or `node:path`.
- No import from `@spec-engine/spec-engine`. The engine depends on the webapp,
  never the reverse.
- Depends only on `@spec-engine/shared` for types and `hono` for routing.
- `index.html` is embedded at compile time via `import ... with { type: "text" }`.
  A runtime `Bun.file` read fails inside the compiled binary.

## Entry point

`server.ts` exports `createApp()`, a Hono factory that mounts every page. The
engine imports it via the `./server` export.

## Data flow

```
authored reqs -> engine builds .spec-engine/index.sqlite -> engine serves /api/* -> pages call /api/* in-process
```

The webapp never touches the index or the filesystem. Pages read their data
through `app.request('/api/...')`, never a loopback fetch.
