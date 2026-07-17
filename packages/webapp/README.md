# @spec-engine/webapp

The local, read-only web UI over the derived index. A Hono app of server-rendered pages.

## What it does

- Renders the coverage matrix and detail views in a browser.
- Served by the engine behind `spec serve <dir>`. Not a standalone deployment.
- Server-side rendered. No client build step, no bundler, no framework runtime.

## Pages

| Route | Page |
|-------|------|
| `GET /` | Coverage matrix (requirement x repo). |
| `GET /report` | Human-facing coverage report. |
| `GET /requirements` | Requirement browser. |
| `GET /relations` | Relates entity diagram. |
| `GET /query?q=...` | Full-text search. |
| `GET /propagation/:id` | Per-member propagation view. |
| `GET /provenance` | Tracker provenance (title, status, url per issue). |
| `GET /editor` | Thin SSR editor over the engine. |

`nav.ts` is the shared nav fragment mounted on every page.

## Constraints (enforced by lint)

- No `bun:sqlite`, `node:fs`, `fs`, `bun`, or `node:path`.
- No import from `@spec-engine/spec-engine` (the engine). The dependency runs one way: engine depends on webapp, never the reverse.
- Depends only on `@spec-engine/shared` for types and `hono` for routing.
- `index.html` is embedded at compile time via Bun's `import ... with { type: "text" }`. Do not switch to a runtime `Bun.file` read; it fails inside the `bun build --compile` binary.

## Entry point

- `server.ts` exports `createApp()`, a Hono factory that mounts every page. The engine imports it via the `./server` export.

## Data flow

```
authored reqs -> engine builds .spec-engine/index.sqlite -> engine reads it -> webapp renders SSR pages
```

The webapp never touches the index or the filesystem directly. The engine hands it data.
