# @spec-engine/shared

Pure, dependency-light contracts shared across the platform. Zod schemas, typed enums, and pure projections with no I/O.

## What it does

- Holds the single source of truth for authored file shapes (config, domain JSON, SPEC) and the derived vocabulary (diagnostics, gate decisions, propagation states).
- Contains only pure logic. No `bun:sqlite`, no `node:fs`, no network. Safe to import from both the engine and the webapp.
- Keeps the engine and webapp in agreement on types without either depending on the other.

## Modules

| File | Role |
|------|------|
| `config.ts` | Zod schemas for member-facing config files (`spec-engine.member.json`). |
| `domain.ts` | The one Zod schema for authored JSON domain files. |
| `schema.ts` | Core requirement and platform schema shapes. |
| `diagnostics.ts` | Diagnostic codes emitted by the derived index. |
| `gate.ts` | Decision vocabulary for `spec gate` (accept, reject, reasons). |
| `propagation.ts` | The propagation state machine for `spec propagation <KEY-NNN>`. |
| `report.ts` | Pure rollup from the (req x repo) coverage matrix for the webapp report. |
| `storage.ts` | Storage-facing shared types. |
| `indexResult.ts` | The `IndexResult` return shape, the seam for a future Rust swap of the parser. |
| `index.ts` | Barrel export. |

## Rules

- Pure only. If a module needs the filesystem, a database, or the network, it belongs in the engine, not here.
- Schemas are the source of truth. Both authoring (validate on write) and the derived index (validate on parse) reuse these definitions rather than redeclaring shapes.
- Projections such as coverage, drift, and propagation are computed from tags, never authored by hand.

## Members

- `@spec-engine/spec-check` (the engine): parsing, indexing, gating, propagation.
- `@spec-engine/webapp`: the coverage report and page rendering.
