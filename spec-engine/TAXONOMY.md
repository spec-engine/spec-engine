# TAXONOMY — domain charters & the requirement-authoring standard

This document does two jobs: it defines what belongs in every domain (the
charters), and it states the rules every new requirement is written against
(the authoring standard). An author — human or agent — reads a domain's
charter here to decide whether a new requirement belongs in it.

Terminology is canonical per [GLOSSARY.md](../GLOSSARY.md): a *domain* is the
concept (named subject area, owner, charter); a *spec* is the
`spec-engine/<KEY>/SPEC.json` artifact recording it; a *requirement* is the
durable `KEY-NNN` unit.

The `scope` field on each `SPEC.json` envelope is the canonical charter: it
ships with every adopter's spec, `spec domain list --json` emits it, and
`spec req` prints it at authoring time. The per-domain sections below are
GENERATED from those fields by `bun scripts/gen-charters.ts` and gated by a
CI fence, so this document cannot drift from them. Edit a charter in its
envelope, then regenerate.

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

Generated from the envelope `scope` fields — do not hand-edit below this
line. Run `bun scripts/gen-charters.ts` after changing a domain's scope.

<!-- BEGIN GENERATED CHARTERS -->

### AUTHOR

**Scope.** The brief→mint authoring pipeline: the three surfaces that turn a
vague brief/ticket into well-formed requirements — the AGENTS.md authoring
playbook (AUTHOR-001), the .claude/skills/req-author skill (AUTHOR-002), and
the spec mcp author_requirements MCP prompt template (AUTHOR-003) — plus the
hard constraint that the engine stays LLM-free.

- **Belongs here:** the authoring-workflow surfaces (playbook doc, skill, MCP
  prompt template) and the LLM-free engine fence.
- **Does not belong here:** the requirement-lifecycle mechanics themselves
  (spec req/supersede/amend → REQ), the domain scaffold (spec domain new →
  DOMAIN), and the charter/authoring-standard doc (→ CHRT). Boundary case: the
  MCP prompt is engine CODE, but it owns the authoring template text only,
  never the mint — the actual requirement write is REQ's promise.

### CHCK

**Scope.** spec check diagnostics and CI-gate semantics, plus the GLOSSARY.md
round-trip: the diagnostic codes and their severities, the --ci cold-rebuild
gate, which severity drives exit 1, and the spec glossary
generate/--migrate/--check behaviors whose drift the GLOSSARY_DRIFT gate
enforces.

- **Belongs here:** the diagnostic codes and severities; the --ci gate; the
  exit-1 contract.
- **Does not belong here:** membership discovery itself (→ INIT). Boundary
  case: check-severity semantics stay in CHCK even when the discovery path
  (INIT) emits the diagnostic, as with the NO_SPEC_CONFIG finding.

### CHRT

**Scope.** Domain charters and the requirement-authoring standard: the
TAXONOMY.md charter doc, the per-envelope scope field, and the CLI surfaces
(spec domain list --json, spec req) that carry a domain's charter to the
author at authoring time.

- **Belongs here:** what tells an author whether a requirement belongs in a
  domain.
- **Does not belong here:** the requirement lifecycle mechanics themselves
  (spec req/supersede/amend → REQ) or the domain scaffold (spec domain new →
  DOMAIN); this domain owns the charter, not the plumbing. Boundary case: a
  single domain's charter TEXT is that domain's own business, while the rule
  that every charter carries a scope sentence, both lists, and a named
  boundary case is CHRT's.

### DIST

**Scope.** The npm distribution surface: what the published
@spec-engine/spec-engine artifact contains (the Bun bundle, the guarded bin
entry, the embedded docs payload) and the CLI surfaces that exist only because
of it (spec docs, the non-Bun runtime guard).

- **Belongs here:** the tarball-content promises, the bin wrapper's runtime
  guard, and the offline docs command.
- **Does not belong here:** the webapp routes the artifact embeds (→ SERV),
  the compiled-binary channel (root build:cli, CI-owned), or the docs site's
  content itself (packages/site, not spec-governed). Boundary case: `spec
  docs` binds loopback-only like `spec serve`, but the promise lives here — it
  is a distribution surface over static files, not a view over the index.

### DOMAIN

**Scope.** Domain lifecycle: spec domain new / spec domain list and charter
editing.

- **Belongs here:** the born-valid scaffold (spec domain new); the domain list
  output; the scope charter field on the envelope.
- **Does not belong here:** requirement authoring (spec req/supersede/amend →
  REQ). Boundary case: minting a requirement id is REQ, scaffolding the domain
  that holds it is DOMAIN.

### GATE

**Scope.** The `spec gate` approval command: the pass/fail decision order
(NOT_FOUND → DRAFT → SUPERSEDED → VERSION_PIN → PASS), pin-equality passing.

- **Belongs here:** the approval decision.
- **Does not belong here:** proof-of-passing → PROOF; loss detection → GUARD.
  Boundary case: an unknown repo name is a usage error (exit 2), not a gate
  failure — that contract belongs to GATE, not CHCK.

### GUARD

**Scope.** Loss detection: diffing the requirement derivation at a git ref
against the working tree to block requirements about to be steamrolled.

- **Belongs here:** REQUIREMENT_REMOVED / IMPL_LOST / VERIFY_LOST /
  SPEC_FILE_DELETED; the supersession and spec deprecate suppression paths;
  never-fail-non-git. Boundary case: GOV-01 (an Active req never disappears
  without approved supersession) folds in here — it names the same concept as
  GUARD-002 at a second enforcement point (CI/base-ref via check/removed.ts vs
  pre-commit/working-tree via guard/losses.ts), unified on one diagnostic code
  (REQUIREMENT_REMOVED).
- **Does not belong here:** who may approve a supersession (that is OWNER, the
  CODEOWNERS policy).

### INDX

**Scope.** The derivation pipeline and index lifecycle: cold-rebuild identity,
build_id determinism, structural integrity at index time, and spec index.

- **Belongs here:** cold-rebuild equivalence (delete .spec-engine/ yields an
  identical result); build_id determinism for identical inputs; the index-time
  structural integrity checks; spec index itself.
- **Does not belong here:** spec check's diagnostic severity semantics (→
  CHCK) or the SPEC.json envelope shape (→ SCHM). Boundary case: cold-rebuild
  identity is an INDX promise even though the model it rebuilds is defined in
  SCHM.

### INIT

**Scope.** Membership, discovery, and onboarding, plus the adoption rungs.

- **Belongs here:** spec init pin authoring; member discovery; the
  progressive-disclosure adoption rungs (rung 1: a lone repo local-only; rung
  2: + the CI gate; rung 3: + a second repo forming a platform with shared
  requirements).
- **Does not belong here:** check-severity semantics (→ CHCK, INIT-007).
  Boundary case: the adoption rungs are three per-rung INIT requirements, each
  independently testable, and stay in INIT.

### MAP

**Scope.** The spec map requirement × repo coverage matrix.

- **Belongs here:** the matrix rows; the src / test / src+test / — rendering;
  the future webapp matrix-view requirements.
- **Does not belong here:** FTS retrieval (→ QURY). Boundary case: MAP stays a
  separate domain rather than folding into a generic read domain because it
  will accrue the webapp matrix-view requirements.

### OWNER

**Scope.** Approval policy: who may retire or supersede a requirement (the
CODEOWNERS policy).

- **Belongs here:** the CODEOWNERS approval policy only.
- **Does not belong here:** the loss-detection mechanism itself (→ GUARD).
  Boundary case: OWNER keeps only the CODEOWNERS approval policy while
  GOV-01's disappearance-detection concept lives in GUARD.

### PROOF

**Scope.** Trusted-red: JUnit ingestion, the PROVEN/UNPROVEN determination,
and rule-reproof under --ci.

- **Belongs here:** --results <junit.xml> ingestion; the PROVEN/UNPROVEN
  status; proof-of-passing enforcement under --ci.
- **Does not belong here:** the bare structural gate with no results file (→
  CHCK's plain diagnostic path). Boundary case: an active requirement with a
  verifying tag but no results file is CHCK's structural check, not a PROOF
  proof.

### PROP

**Scope.** Propagation and migration state, including the drift definition.

- **Belongs here:** the per-repo migrated/drifted state; spec propagation; the
  drift definition itself.
- **Does not belong here:** the SPEC.json model shape (→ SCHM). Boundary case:
  the drift definition lands in PROP, not SCHM — it is the propagation
  contract, and the SQL view computing it is merely enforcement.

### PROV

**Scope.** The spec provenance matrix and the issue-link provenance model,
with issue_id held as an opaque external payload.

- **Belongs here:** the provenance matrix rows and their sort/render; the
  **Issues:** role:ID parse into (req_id, issue_id, role); the doctrine that
  issue_id is opaque — projected only, never a PK/FK/UNIQUE/index/JOIN key.
- **Does not belong here:** the tracker fetch/cache that resolves an issue id
  to a title (→ TRK); requirement identity/routing (issue ids are provenance,
  never identity). Boundary case: a KEY-NNN-shaped issue id stays an opaque
  string in PROV and is never resolved against the requirements table.

### QURY

**Scope.** The spec query full-text retrieval command.

- **Belongs here:** FTS5 MATCH semantics; rank-ascending results; superseded
  exclusion; --limit bounds.
- **Does not belong here:** file→requirement resolution (→ RSLV). Boundary
  case: a bare AND OR FTS5 grammar error is a QURY usage-error (exit 2)
  contract.

### REQ

**Scope.** Requirement lifecycle: spec req, spec supersede, spec amend, and
@-refs.

- **Belongs here:** next-id allocation; non-interactive authoring; supersede /
  move / amend; @path file-ref resolution.
- **Does not belong here:** scaffolding a whole domain (spec domain new →
  DOMAIN). Boundary case: minting a requirement id is REQ, scaffolding the
  domain that holds it is DOMAIN.

### RSLV

**Scope.** The spec resolve files→requirements command and its --req reverse
query.

- **Belongs here:** file→requirement mapping; the --req reverse tag-site
  query; path-containment normalization.
- **Does not belong here:** full-text search (→ QURY). Boundary case: an
  absolute path resolving outside platformDir is an RSLV exit-2 contract,
  never a silent [].

### SCHM

**Scope.** The shared data model: the SPEC.json envelope, the DDL, the
coverage view, and the one-model-one-seam promise (CLI, webapp, and MCP can
never disagree — one model, one storage seam).

- **Belongs here:** the @spec-engine/shared schema every read/write surface
  shares; the DDL; the coverage SQL view; the one-model-one-seam promise.
- **Does not belong here:** the drift definition (→ PROP), cold-rebuild
  identity (→ INDX), or loopback-only binding (→ SERV). Boundary case:
  one-model-one-seam is restated here as a promise, but cold-rebuild identity
  stays an INDX promise and loopback-only stays a SERV promise.

### SERV

**Scope.** The spec serve local webapp + /api/* over the index.

- **Belongs here:** the SSR pages; the /api/* route contracts; loopback-only
  binding.
- **Does not belong here:** the one-model-one-seam promise (→ SCHM). Boundary
  case: loopback-only stays a SERV promise even though the data model it
  serves is defined in SCHM.

### TERM

**Scope.** The reserved glossary domain: durable TERMs — a headword, its
definition (carried in the requirement statement), aliases, and pinned cites —
that requirements reference and that are drift-checked against their pinned
version, but that are EXCLUDED from code coverage (a term is a requirement
row, never an @spec-tagged code obligation).

- **Belongs here:** glossary term entries (TERM-NNN) with their aliases and
  citations; the term-drift concern.
- **Does not belong here:** a feature requirement ABOUT the term store — the
  schema fields belong in SCHM, the spec term authoring CLI in REQ, the check
  diagnostics in CHCK, the query surface in QURY — those are dogfood
  requirements in their concept domains, never TERM data rows. Boundary case:
  the TERM-01 schema-fields promise lives in SCHM (concept wins), while the
  glossary data rows TERM-001..N live here.

### TRK

**Scope.** The @spec-engine/tracker package: the offline-default adapter and
the optional Linear read integration that resolves an opaque issue_id to a
title/URL for display.

- **Belongs here:** the adapter interface + offline noop adapter; the single
  read query to the tracker; the SPEC_TRACKER_TOKEN auth + no-token
  short-circuit; the sidecar cache; the engine-isolation boundary (engine
  internals never import the tracker; no external network from the derivation
  path).
- **Does not belong here:** how a display surface labels expired-cache data in
  its own output (→ PROV); the provenance matrix + issue-id opacity model
  itself (→ PROV); any write back to the tracker (forbidden — the integration
  is one-way/read-only). Boundary case: resolving an issue_id to a title is a
  TRK concern, but the opacity of that id inside the engine's index stays a
  PROV promise.

<!-- END GENERATED CHARTERS -->

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
