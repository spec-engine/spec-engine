# TAXONOMY — domain charters & the requirement-authoring standard

Two jobs: the charter of every domain (what belongs in it), and the rules every
new requirement is written against. An author, human or agent, reads a domain's
charter here to decide whether a new requirement belongs in it.

- Terminology is canonical per [GLOSSARY.md](../GLOSSARY.md): a *domain* is the
  concept, a *spec* is the `spec-engine/<KEY>/SPEC.json` artifact recording it,
  a *requirement* is the durable `KEY-NNN` unit.
- The `scope` field on each `SPEC.json` envelope is the canonical charter. It
  ships with every adopter's spec, `spec domain list --json` emits it, and
  `spec req` prints it at authoring time.
- The per-domain sections below are generated from those fields by
  `bun scripts/gen-charters.ts` and gated by a CI fence. Edit a charter in its
  envelope, then regenerate.

## Placement rule: the concept wins

- Domains describe product promises. A requirement belongs to the domain whose
  promise it protects.
- `livesIn` records where the promise is enforced, not which domain owns it.
- A rule that protects no user-facing promise is a development convention in
  AGENTS.md or a CI script, not a requirement. A CI fence that protects a
  promise carries that promise's id: the fence function is tagged with it and
  the fence label starts with it. There is no ARCH domain.

## Requirement id format

- Ids are `KEY-NNN`, a 3-digit zero-padded number: `CHRT-007`, `BILLING-010`.
- Two-digit shorthand in old planning notes (`CHRT-01`) is a label, never a real id.
- Ids are permanent. A requirement is superseded or deprecated, never renumbered
  and never deleted.

---

## Per-domain charters

Each entry: the domain's scope sentence, a **belongs here** list, and a
**does not belong here** list with one named boundary case.

Generated from the envelope `scope` fields. Do not hand-edit below this line.
Run `bun scripts/gen-charters.ts` after changing a domain's scope.

<!-- BEGIN GENERATED CHARTERS -->

### AUTHOR

**Scope.** How a brief or ticket becomes well-formed requirements: the
AGENTS.md authoring playbook, the req-author skill, the MCP
author_requirements prompt, and the rule that the engine runs no model.

- **Belongs here:** the authoring-workflow surfaces and the LLM-free engine
  fence.
- **Does not belong here:** the mint itself (REQ), the domain scaffold
  (DOMAIN), the charter doc (CHRT). Boundary case: the MCP prompt is engine
  code, but it owns only the template text; the write is REQ's promise.

### CHCK

**Scope.** spec check: the diagnostic codes, their severities, the --ci
cold-rebuild gate, which severity exits 1, and the spec glossary round-trip
that GLOSSARY_DRIFT enforces.

- **Belongs here:** diagnostic codes and severities; the --ci gate; the exit-1
  contract.
- **Does not belong here:** member discovery (INIT). Boundary case:
  NO_SPEC_CONFIG is emitted by discovery, but its severity is CHCK's.

### CHRT

**Scope.** Domain charters and the requirement-authoring standard:
TAXONOMY.md, the envelope scope field, and the CLI surfaces that show an
author a charter (spec domain list --json, spec req).

- **Belongs here:** what tells an author whether a requirement belongs in a
  domain.
- **Does not belong here:** requirement lifecycle mechanics (REQ), the domain
  scaffold (DOMAIN). Boundary case: one domain's charter text is that domain's
  business; the rule that every charter has a scope sentence, both lists, and
  a boundary case is CHRT's.

### DIST

**Scope.** The npm distribution surface: what the published
@spec-engine/spec-engine artifact contains and the CLI surfaces that exist
only because of it (spec docs, the non-Bun runtime guard).

- **Belongs here:** tarball-content promises; the bin wrapper's runtime guard;
  the offline docs command.
- **Does not belong here:** the webapp routes the artifact embeds (SERV); the
  compiled-binary channel (CI-owned); the docs site content (packages/site).
  Boundary case: spec docs binds loopback like spec serve, but it is a
  distribution surface over static files, so the promise lives here.

### DOMAIN

**Scope.** Domain lifecycle: spec domain new, spec domain list, and charter
editing.

- **Belongs here:** the born-valid scaffold; the domain list output; the scope
  field on the envelope.
- **Does not belong here:** requirement authoring (REQ). Boundary case:
  minting a requirement id is REQ; scaffolding the domain that holds it is
  DOMAIN.

### GATE

**Scope.** The spec gate approval command: the decision order NOT_FOUND,
DRAFT, SUPERSEDED, DEPRECATED, VERSION_PIN, PASS, with pin equality passing.

- **Belongs here:** the approval decision.
- **Does not belong here:** proof-of-passing (PROOF); loss detection (GUARD).
  Boundary case: an unknown repo name is a usage error (exit 2), not a gate
  failure, and that contract is GATE's.

### GUARD

**Scope.** Loss detection: diffing the requirement derivation at a git ref
against the working tree to block a change that would lose a requirement.

- **Belongs here:** REQUIREMENT_REMOVED, IMPL_LOST, VERIFY_LOST,
  SPEC_FILE_DELETED; the supersede and deprecate suppression paths; never-fail
  outside git.
- **Does not belong here:** who may approve a supersession (OWNER). Boundary
  case: the same REQUIREMENT_REMOVED concept is enforced twice, at pre-commit
  by spec guard and at CI by spec check --base, and both live here.

### INDX

**Scope.** The derivation pipeline and index lifecycle: cold-rebuild identity,
build_id determinism, structural integrity at index time, and spec index.

- **Belongs here:** deleting .spec-engine/ and rebuilding yields an identical
  result; build_id is deterministic for identical inputs; index-time
  structural checks; spec index itself.
- **Does not belong here:** check severities (CHCK); the SPEC.json envelope
  shape (SCHM). Boundary case: cold-rebuild identity is INDX's promise even
  though the model it rebuilds is defined in SCHM.

### INIT

**Scope.** Membership, discovery, and onboarding, plus the adoption rungs.

- **Belongs here:** spec init pin authoring; member discovery; the three
  adoption rungs (a lone repo; plus the CI gate; plus a second repo sharing
  requirements).
- **Does not belong here:** check severities (CHCK). Boundary case: each rung
  is its own INIT requirement, independently testable.

### MAP

**Scope.** The spec map requirement-by-repo coverage matrix.

- **Belongs here:** the matrix rows; the src, test, src+test, and dash
  rendering; the webapp matrix view.
- **Does not belong here:** full-text retrieval (QURY). Boundary case: MAP
  stays its own domain because the webapp matrix view will accrue here.

### OWNER

**Scope.** Approval policy: who may retire or supersede a requirement, via
CODEOWNERS.

- **Belongs here:** the CODEOWNERS approval policy.
- **Does not belong here:** the loss-detection mechanism (GUARD). Boundary
  case: detecting that a requirement disappeared is GUARD; deciding who may
  approve that is OWNER.

### PROOF

**Scope.** Trusted-red: JUnit ingestion, the PROVEN/UNPROVEN determination,
and proof enforcement under --ci.

- **Belongs here:** --results ingestion; the PROVEN/UNPROVEN status;
  proof-of-passing under --ci.
- **Does not belong here:** the structural gate with no results file (CHCK).
  Boundary case: an active requirement with a verifying tag but no results
  file is CHCK's structural check, not a PROOF proof.

### PROP

**Scope.** Propagation and migration state, including the drift definition.

- **Belongs here:** the per-repo migrated or drifted state; spec propagation;
  the drift definition.
- **Does not belong here:** the SPEC.json model shape (SCHM). Boundary case:
  the drift definition is PROP's contract; the SQL view that computes it is
  only enforcement.

### PROV

**Scope.** The spec provenance matrix and the issue-link model, with issue_id
an opaque external payload.

- **Belongs here:** the matrix rows and their sort and render; the role:ID
  parse into (req_id, issue_id, role); issue_id is projected only, never a
  key.
- **Does not belong here:** resolving an issue id to a title (TRK);
  requirement identity or routing. Boundary case: an issue id shaped like
  KEY-NNN stays an opaque string and is never resolved against the
  requirements table.

### QURY

**Scope.** The spec query full-text retrieval command.

- **Belongs here:** FTS5 MATCH semantics; rank-ascending results; superseded
  exclusion; --limit bounds.
- **Does not belong here:** file-to-requirement resolution (RSLV). Boundary
  case: a bare AND or OR is an FTS5 grammar error and a QURY exit-2 contract.

### REQ

**Scope.** Requirement lifecycle: spec req, spec supersede, spec amend, and
@-refs.

- **Belongs here:** next-id allocation; non-interactive authoring; supersede,
  move, and amend; @path file-ref resolution.
- **Does not belong here:** scaffolding a domain (DOMAIN). Boundary case:
  minting a requirement id is REQ; scaffolding the domain that holds it is
  DOMAIN.

### RSLV

**Scope.** The spec resolve files-to-requirements command and its --req
reverse query.

- **Belongs here:** file-to-requirement mapping; the --req reverse tag-site
  query; path-containment normalization.
- **Does not belong here:** full-text search (QURY). Boundary case: an
  absolute path resolving outside platformDir exits 2, never a silent empty
  result.

### SCHM

**Scope.** The shared data model: the SPEC.json envelope, the DDL, the
coverage view, and the promise that CLI, webapp, and MCP never disagree.

- **Belongs here:** the @spec-engine/shared schema every surface shares; the
  DDL; the coverage SQL view; one model, one storage seam.
- **Does not belong here:** the drift definition (PROP); cold-rebuild identity
  (INDX); loopback-only binding (SERV). Boundary case: one-model-one-seam is
  stated here; cold-rebuild identity stays INDX's and loopback-only stays
  SERV's.

### SERV

**Scope.** The spec serve local webapp and /api/* over the index.

- **Belongs here:** the server-rendered pages; the /api/* route contracts;
  loopback-only binding.
- **Does not belong here:** the one-model-one-seam promise (SCHM). Boundary
  case: loopback-only is SERV's promise even though the data model it serves
  is SCHM's.

### TERM

**Scope.** The reserved glossary domain: durable terms with a headword, a
definition in the statement, aliases, and pinned citations, drift-checked
against their pinned version and excluded from code coverage.

- **Belongs here:** glossary term entries (TERM-NNN) with aliases and
  citations; the term-drift concern.
- **Does not belong here:** feature requirements about the term store, which
  live in their concept domains (fields in SCHM, the spec term CLI in REQ,
  diagnostics in CHCK, the query surface in QURY). Boundary case: the
  term-store schema promise is SCHM's; the term rows TERM-001..N are here.

### TRK

**Scope.** The @spec-engine/tracker package: the offline noop adapter and the
optional read-only Linear integration that resolves an opaque issue_id to a
title and URL.

- **Belongs here:** the adapter interface and noop default; the single read
  query; SPEC_TRACKER_TOKEN handling and the no-token short-circuit; the
  sidecar cache; the isolation boundary (engine internals never import the
  tracker, no network on the derivation path).
- **Does not belong here:** how a display surface labels expired-cache data
  (PROV); the provenance matrix and issue-id opacity (PROV); any write back to
  the tracker. Boundary case: resolving an issue id is TRK's; the opacity of
  that id inside the index is PROV's.

<!-- END GENERATED CHARTERS -->

---

## Requirement authoring standard

The rules every new requirement is written against. The `req-author` skill
applies them. The statement-shape rule is also checked at write time and by
`spec check`.

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
| 1 | INDX | INDX-007 | Cold-rebuild identity: deleting `.spec-engine/` and rebuilding yields an identical result. |
| 2 | CHCK | CHCK-014 | `spec check --ci` builds fresh. Correctness never trusts a cached or warm index. |
| 3 | SCHM | SCHM-013 | One shared schema. Every read and write surface validates the same envelope. |
| 4 | INDX | INDX-008 | Spec defects become diagnostics. A duplicate id or broken supersede never crashes the index build. |
| 5 | SCHM | SCHM-012 | One model, one storage seam. CLI, webapp, and MCP can never disagree. |
| 6 | PROP | PROP-004 | The drift definition is the propagation contract, computed by a SQL view. |
