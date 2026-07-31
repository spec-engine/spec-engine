# TAXONOMY — domain charters & the requirement-authoring standard

This document does two jobs: it defines what belongs in every domain (the
charters), and it states the rules every new requirement is written against
(the authoring standard). An author — human or agent — reads a domain's
charter here to decide whether a new requirement belongs in it.

Terminology is canonical per [GLOSSARY.md](../GLOSSARY.md): a *domain* is the
concept (named subject area, owner, charter); a *spec* is the
`spec-engine/<KEY>/SPEC.json` artifact recording it; a *requirement* is the
durable `KEY-NNN` unit.

Charters travel two ways: this document, and the `scope` field on each
`SPEC.json` envelope — so the charter ships with every adopter's spec,
`spec domain list --json` emits it, and `spec req` prints it at authoring time.

## Placement rule: the concept wins

Domains describe **product promises**; a requirement belongs to the domain
whose promise it protects. `livesIn` records where the promise is enforced,
not which domain owns it. A rule that protects no user-facing promise — an
architecture convention, an import fence — is a development convention
(AGENTS.md or a CI script), not a requirement, so there is no ARCH domain.

## Requirement id format

Requirement ids are `KEY-NNN` where `NNN` is a 3-digit, zero-padded number:
`CHRT-007`, `BILLING-010`. Two-digit shorthand seen in old planning notes
(`CHRT-01`) is a label, never a real id. Ids are permanent — a requirement is
superseded or deprecated, never renumbered and never deleted.

---

## Per-domain charters

Each entry gives the domain's scope sentence, a **belongs here** list, and a
**does not belong here** list with at least one named boundary case.

### INDX — derivation pipeline & index lifecycle

**Scope.** The derivation pipeline and index lifecycle: cold-rebuild identity,
`build_id` determinism, structural integrity at index time, and `spec index`.

- **Belongs here:** cold-rebuild equivalence (delete `.spec-engine/` → identical
  result); `build_id` determinism for identical inputs; the index-time structural
  integrity checks; `spec index` itself; the stale-index warning on read commands.
- **Does not belong here:** `spec check`'s diagnostic *severity* semantics
  (→ CHCK); the SPEC.json envelope *shape* (→ SCHM). Boundary case: cold-rebuild
  identity is an **INDX** promise even though the model it rebuilds is defined in
  SCHM.

### SCHM — shared data model

**Scope.** The shared data model: the SPEC.json envelope, the DDL, the coverage
view, and the promise that CLI, webapp, and MCP read one model through one
storage seam and can never disagree.

- **Belongs here:** the `@spec-engine/shared` schema every read/write surface
  shares; the DDL; the coverage SQL view; the envelope's grammar declaration
  fields.
- **Does not belong here:** the **drift definition** (→ PROP — it is the
  propagation contract, not the model); **cold-rebuild identity** (→ INDX);
  **loopback-only** binding (→ SERV). Boundary case: the one-model promise is
  SCHM's, but cold-rebuild identity stays an INDX promise and loopback-only
  stays a SERV promise.

### CHCK — `spec check` diagnostics & CI-gate semantics

**Scope.** `spec check` diagnostics and CI-gate semantics.

- **Belongs here:** the diagnostic codes and their severities; the `--ci`
  cold-rebuild gate; which severity drives exit 1; default deletion detection;
  the statement-grammar check.
- **Does not belong here:** membership discovery itself (→ INIT). Boundary case:
  check-severity semantics belong to CHCK even when discovery (INIT) emits the
  diagnostic — the `NO_SPEC_CONFIG` finding originates in the discovery path,
  but its severity is a CHCK promise.

### PROOF — proof of passing

**Scope.** Proof that requirements are backed by passing tests: JUnit
ingestion, the PROVEN/UNPROVEN determination, and proof enforcement under
`--ci`.

- **Belongs here:** `--results <junit.xml>` ingestion; the PROVEN/UNPROVEN
  determination; proof-of-passing enforcement under `--ci`.
- **Does not belong here:** the bare structural gate with no results file
  (CHCK's plain diagnostic path). Boundary case: a requirement with zero
  verifying tags is UNVERIFIED (CHCK's business); UNPROVEN applies only when a
  verifying tag exists but its test is failing or missing.

### GATE — the `spec gate` approval command

**Scope.** The `spec gate` approval command.

- **Belongs here:** the pass/fail decision order (NOT_FOUND → DRAFT →
  SUPERSEDED → DEPRECATED → VERSION_PIN → PASS); pin-equality passing.
- **Does not belong here:** proof-of-passing (→ PROOF); loss detection
  (→ GUARD). Boundary case: an unknown repo name is a *usage error* (exit 2),
  not a gate failure — that contract belongs to GATE, not CHCK.

### GUARD — loss detection

**Scope.** Loss detection: diffing the requirement derivation at a git ref
against the working tree to block a change that would silently lose a
requirement, its last implementation, or its last test.

- **Belongs here:** REQUIREMENT_REMOVED / IMPL_LOST / VERIFY_LOST /
  SPEC_FILE_DELETED; the rule that a loss is suppressed only by superseding or
  deprecating the requirement in the same change; never failing outside git.
- **Does not belong here:** *who may* approve a supersession (→ OWNER, the
  CODEOWNERS policy). Boundary case: the same disappearance concept is enforced
  at two points — pre-commit against the working tree (this domain) and in
  `spec check` against HEAD (CHCK) — unified on one diagnostic code.

### OWNER — approval policy

**Scope.** Approval policy: who may end or supersede a requirement
(CODEOWNERS).

- **Belongs here:** the CODEOWNERS approval policy only.
- **Does not belong here:** the loss-detection mechanism itself (→ GUARD).

### DOMAIN — domain lifecycle

**Scope.** Domain lifecycle: `spec domain new`, `spec domain list`, and the
charter field.

- **Belongs here:** the scaffold that always produces a schema-valid envelope;
  `domain list` output; the `scope` charter field on the envelope.
- **Does not belong here:** requirement authoring (→ REQ). Boundary case:
  minting a requirement id is REQ; scaffolding the domain that holds it is
  DOMAIN.

### REQ — requirement lifecycle

**Scope.** Requirement lifecycle: `spec req`, `spec supersede`, `spec amend`,
`spec deprecate`, `spec move`, and `@`-path references.

- **Belongs here:** next-id allocation; non-interactive authoring; supersede /
  move / amend / deprecate; `@path` file-reference resolution; write-time
  statement-grammar enforcement.
- **Does not belong here:** scaffolding a whole domain (→ DOMAIN).

### INIT — membership, discovery, onboarding

**Scope.** Membership, discovery, onboarding, and the adoption steps (a lone
repo local-only; adding the CI gate; adding a second repo to form a platform).

- **Belongs here:** `spec init` pin authoring; member discovery; the adoption
  steps.
- **Does not belong here:** check-severity semantics (→ CHCK).

### PROP — propagation & migration state

**Scope.** Propagation and migration state, including the drift definition.

- **Belongs here:** the per-repo migrated/drifted state; `spec propagation`;
  the drift definition itself.
- **Does not belong here:** the SPEC.json model shape (→ SCHM). Boundary case:
  the drift definition belongs to PROP, not SCHM — it is the propagation
  contract; the SQL view computing it is merely enforcement.

### MAP — the coverage-matrix read command

**Scope.** The `spec map` requirement × repo coverage matrix.

- **Belongs here:** the matrix rows; the `src` / `test` / `src+test` / `—`
  rendering; webapp matrix-view requirements as they land.
- **Does not belong here:** full-text search (→ QURY).

### QURY — the full-text retrieval read command

**Scope.** The `spec query` full-text retrieval command.

- **Belongs here:** the search syntax contract; result ordering; which
  statuses are excluded from live results; `--limit` bounds.
- **Does not belong here:** file→requirement resolution (→ RSLV). Boundary
  case: a search-syntax error is a QURY usage-error (exit 2) contract.

### RSLV — the file→requirement read command

**Scope.** The `spec resolve` files → requirements command and its `--req`
reverse query.

- **Belongs here:** file→requirement mapping; the `--req` reverse tag-site
  query; path-containment normalization.
- **Does not belong here:** full-text search (→ QURY). Boundary case: an
  absolute path resolving outside the platform directory is an RSLV exit-2
  contract, never a silent `[]`.

### SERV — the local webapp / API

**Scope.** The `spec serve` local webapp and `/api/*` routes over the index,
including the feature-flag surface.

- **Belongs here:** the SSR pages; the `/api/*` route contracts; loopback-only
  binding; the rule that a flagged-off feature refuses every surface (nav,
  page, and endpoints together).
- **Does not belong here:** the one-model promise (→ SCHM). Boundary case:
  loopback-only stays a SERV promise even though the data model it serves is
  defined in SCHM.

### PROV — provenance surface & issue-link opacity

**Scope.** The `spec provenance` matrix and the issue-link provenance model:
per-requirement creating/revising ticket links surfaced beside backing tests
and the git pointer, with the ticket id held as an opaque external payload.

- **Belongs here:** the provenance matrix rows and their sort/render; the
  issue-role model (created / supersedes-via / amends-via); the doctrine that
  a ticket id is opaque — displayed and filtered, never a key, never routing,
  never a requirement id.
- **Does not belong here:** the tracker fetch/cache that resolves a ticket id
  to a title (→ TRK). Boundary case: a ticket id shaped like a requirement id
  (`BILLING-001` used as a ticket name) stays an opaque string and is never
  resolved against the requirements table.

### TRK — issue-tracker integration

**Scope.** The `@spec-engine/tracker` package: the offline-default adapter and
the optional read-only Linear integration that resolves an opaque ticket id to
a title and URL for display.

- **Belongs here:** the adapter interface and offline default; the single read
  query to the tracker; the `SPEC_TRACKER_TOKEN` handling and no-token
  short-circuit; the sidecar cache and its staleness labeling; the boundary
  that engine internals never import the tracker and the derivation path makes
  no network call.
- **Does not belong here:** the provenance matrix and opacity model (→ PROV);
  any write back to the tracker (forbidden — the integration is read-only).

### AUTHOR — the brief→mint authoring pipeline

**Scope.** The surfaces that turn a rough brief or ticket into well-formed
requirements — the AGENTS.md authoring playbook, the `req-author` skill, and
the `author_requirements` MCP prompt — plus the constraint that the engine
itself runs no language model.

- **Belongs here:** the authoring-workflow surfaces and the engine-runs-no-model
  fence.
- **Does not belong here:** the requirement-lifecycle commands themselves
  (→ REQ); the domain scaffold (→ DOMAIN); this document (→ CHRT). Boundary
  case: the `author_requirements` prompt is engine code, but it owns the
  template text only — the actual write is REQ's promise.

### CHRT — the charter document and authoring standard

**Scope.** This document's own machinery: the per-domain charter model, the
charter's two homes (this file and the envelope `scope` field), and the
authoring standard below.

- **Belongs here:** the charter field round-trip; the charter echo at
  authoring time; the requirement-authoring standard.
- **Does not belong here:** any single domain's charter content (that is the
  domain's own business).

### DIST — distribution

**Scope.** How Spec Engine reaches users: the npm package contents, the
compiled binary, and the offline documentation site (`spec docs`).

- **Belongs here:** the published package contents; `spec docs` serving the
  prebuilt site over loopback; resolution of the docs root.
- **Does not belong here:** the live webapp over the index (→ SERV).

### TERM — reserved glossary domain

**Scope.** The reserved glossary domain: durable terms — a headword, its
definition (carried in the statement field), aliases, and pinned citations —
that requirements reference and that are drift-checked against their pinned
version. Terms are excluded from code coverage: a term is a definition, never
an `@spec`-tagged code obligation.

- **Belongs here:** glossary term entries (TERM-NNN) with their aliases and
  citations; the term-drift concern (a citation pinned behind the term's
  current version).
- **Does not belong here:** feature requirements *about* the term store — the
  schema fields (→ SCHM), the term authoring CLI (→ REQ), the term-check
  diagnostics (→ CHCK), the term search surface (→ QURY). Boundary case: the
  schema-fields promise lives in SCHM (it protects the one-model schema),
  while the glossary data rows live here. The two id spaces never collide:
  feature code is tagged `@spec SCHM-NNN`; glossary data is authored at
  `TERM-NNN`.

### Archive domains — AUTHC, POC, GOV

These three domains hold no Active requirements: every entry is superseded or
deprecated. They are history — the permanent record of requirements that were
reorganized into the domains above — and are never deleted. Do not mint new
requirements in them.

---

## Requirement authoring standard

The rules every new requirement is written against. The `req-author` skill
applies them; the statement-shape rule is also checked mechanically at write
time and by `spec check`.

1. **One behavior per requirement.** A ticket usually splits into several
   requirements. Never mint one requirement per ticket.
2. **Write the statement in the fixed shape.** Pick the sentence shape that
   matches the situation (the word "shall" separates who acts from the
   observable result):

   | Situation | Shape | Example |
   |---|---|---|
   | Always true | The `<system>` shall `<result>` | The spec CLI shall write JSON output to stdout only. |
   | Triggered by an event | When `<trigger>`, the `<system>` shall `<result>` | When an unknown requirement id is passed, spec resolve shall print `[]` and exit 0. |
   | Only in a certain state | While `<state>`, the `<system>` shall `<result>` | While the index file is missing, read commands shall rebuild it before answering. |
   | Handling something going wrong | If `<failure>`, then the `<system>` shall `<result>` | If the results file cannot be parsed, then spec check shall report the file and exit 2. |
   | Only when a feature is present | Where `<feature>`, the `<system>` shall `<result>` | Where a member config lists ignore directories, the scanner shall skip them. |

   If your statement fits no row, you have not yet decided what triggers the
   behavior or what observably happens — which is the problem the shape exists
   to catch.

   A statement may end with a trailing `so <observable consequence>` clause
   ("…shall report NO_SPEC_CONFIG at warning severity, so a lone warning never
   fails the gate") when the consequence is itself observable. Rationale —
   *why the behavior exists* — still belongs in the why, never in the
   statement.
3. **It must make sense on its own.** A reader seeing only this one statement —
   in search results, in a report — understands it. If it says "the
   normalization" or "that prefix" without naming the subject, it fails.
4. **Describe what it does, not how.** Say what a user or calling agent
   observes. If renaming an internal function would make the statement wrong,
   it is written at the wrong level.
5. **No expiration dates.** No "currently", no "the new behavior", no
   references to things that were removed.
6. **The why states what breaks.** Answer "what goes wrong if this stops being
   true" — never restate the requirement in different words.
7. **Three link types, three jobs.** Tests prove it. Code implements it.
   Tickets are only history — never an id, never proof.
8. **File it where the promise lives, and search first.** Pick the domain
   whose charter covers this behavior, and run `spec query` before minting —
   if something close exists, amend it instead.

---

## Six invariants worth knowing

Six promises the whole system leans on, each a real requirement in its domain:

| # | Domain | Requirement | Invariant |
|---|--------|-------------|-----------|
| 1 | INDX | INDX-007 | Cold-rebuild identity — deleting `.spec-engine/` and rebuilding yields an identical result. |
| 2 | CHCK | CHCK-014 | `spec check --ci` builds fresh — correctness never trusts a cached or warm index. |
| 3 | SCHM | SCHM-013 | One shared schema — every read/write surface validates the same envelope. |
| 4 | INDX | INDX-008 | Spec defects become diagnostics — a duplicate id or broken supersede never crashes the index build. |
| 5 | SCHM | SCHM-012 | One model, one storage seam — CLI, webapp, and MCP can never disagree. |
| 6 | PROP | PROP-004 | The drift definition is the propagation contract, computed by a SQL view. |
