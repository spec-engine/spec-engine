---
title: SPEC.json Format
description: The SPEC.json authoring and interchange format
---

One JSON **domain envelope** per domain, at `spec-engine/<KEY>/SPEC.json`. Human-readable, machine-validated — every read and write surface (CLI, webapp, MCP) validates it through the same shared schema. Prefer authoring through the CLI (`spec domain new`, `spec req`, `spec supersede`, …), which writes through a single validated seam; hand-edits are legal but validated on the next index.

```json
{
  "key": "BILLING",
  "owner": "drea",
  "updated": "2026-06-02",
  "scope": "Charging, renewal, refunds. Does not belong here: tax rules (TAX).",
  "requirements": [
    {
      "id": "BILLING-009",
      "status": "active",
      "statement": "When a subscription renews, charge the saved payment method at the current plan price.",
      "why": "Revenue path. Silent failure loses money with no visible error.",
      "issues": [{ "role": "created", "id": "ENG-1432" }],
      "relates": ["BILLING-002", "BILLING-007"],
      "livesIn": ["@lib-billing/renew.ts"]
    }
  ]
}
```

## The envelope

| Field | Description |
| --- | --- |
| `key` | The domain key (`UPPERCASE`), matching the folder name |
| `owner` | Optional owner string (nullable) |
| `updated` | Last-touched date; advanced by every authoring command |
| `scope` | Optional domain **charter** — what belongs in this domain and what doesn't; consulted at authoring time (`spec req <domain>` prints it) |
| `requirements` | The requirement entries, in order |

**There is no authored version counter.** A requirement domain's version is **derived** from its supersede history — version = 1 + the number of superseded entries — so it advances exactly when a requirement is superseded and can never be hand-edited into disagreeing with what happened. The one exception is the reserved `TERM` domain (the glossary), whose envelope keeps an authored `specVersion`: `spec term revise` bumps it in place, and it serves as the pin term-citation drift is measured against.

## Requirement fields

| Field | Description |
| --- | --- |
| `id` | Permanent `KEY-NNN` id — never reused, never renumbered |
| `status` | `active` \| `draft` \| `superseded` \| `retired` (lowercase in the file) |
| `statement` | The requirement statement — the testable promise |
| `why` | Rationale: the failure mode if the promise is violated |
| `supersededBy` | Set when superseded: the successor's id (resolved globally, so a cross-domain `spec move` works) |
| `supersededAtVersion` | The derived domain version at which the entry died — stamped once at supersession |
| `relates` | Advisory links to other requirement ids (rendered by `spec relations`) |
| `livesIn` | Where the requirement is *enforced* — `@<path>` refs. Metadata, not identity |
| `issues` | Optional provenance — see below |

Glossary `TERM` entries reuse the same shape plus `term` (the headword), `aliases`, `cites` (pinned term citations), and `section` (the GLOSSARY.md heading).

## Status lifecycle

- **active** — in force
- **draft** — not yet approved
- **superseded** — replaced by a successor; the old entry stays in the file as history, pointing forward via `supersededBy`
- **retired** — deliberately ended with no successor (requires owner approval)

## Provenance (`issues`)

Optional tracker links, by **role** — `created` is a different relationship than `supersedes-via`:

```json
"issues": [
  { "role": "created", "id": "ENG-1432" },
  { "role": "supersedes-via", "id": "ENG-1781" }
]
```

- **Roles** (closed allow-list): `created`, `supersedes-via`, `amends-via`. A token with an unknown role is surfaced as an `UNKNOWN_ROLE` warning and dropped — never stored silently.
- **Issue IDs are opaque.** The engine treats them as strings and never makes a network call. Nothing resolves, routes, stores coverage by, or keys on an issue ID — it is provenance, not identity. One issue fans out into several requirements; one requirement accumulates several issues across its life.
- **Resolution is an adapter concern.** The optional tracker adapter turns IDs into titles/status/URLs; the core engine stays fully offline.

`spec provenance` renders the matrix derived from this field. See [Commands](/commands/).

## Amend vs supersede

**Amend** in place (same ID, no version change) while a requirement has never been true in production. **Supersede** (new ID; the old entry is retained and points forward) once it has shipped — the domain version derives one step forward. IDs are never reused.
