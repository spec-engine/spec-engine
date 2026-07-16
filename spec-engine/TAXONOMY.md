# TAXONOMY — domain charters & the requirement-authoring standard

This is the charter doc: the "what belongs here" definition for every domain in
the spec engine. It is the mechanism that keeps the taxonomy from re-rotting
after a reorg — an author (human or agent) reads a domain's charter to decide
whether a new requirement belongs in it. Terminology is canonical per
[GLOSSARY.md](../GLOSSARY.md): a *domain* is the concept (named subject area,
owner, charter); a *spec* is the `spec-engine/<KEY>/SPEC.json` artifact recording
it; a *requirement* is the durable `KEY-NNN` unit.

Content here is DECIDED design lifted from `recommendations.md` §4.5 (the
evidence-based target taxonomy), §4.6 (the two-level charter design), §4.8 (the
standalone-comprehensibility audit + the six headline invariants), and §4.10
(the requirement-authoring standard). Charters travel two ways: this doc now, and
the `scope` field on each `SPEC.json` envelope (the product feature) so the
charter ships with every adopter's spec, `spec domain list --json` emits it, and
`spec req` prints it at authoring time.

## Placement rule (DECIDED, drea 2026-07-07): concept wins

Domains describe **product promises**; a requirement belongs to the domain whose
promise it protects. `livesIn` records where the promise is enforced, not which
domain owns it. Corollary: an "architecture rule" that protects no user-facing
promise is a development convention (AGENTS.md / CI-fence material), **not** a
spec-engine requirement — so there is **no ARCH domain** (AUTHC-017's
import-count rule was evicted to AGENTS.md + the existing D-08 CI fence).

## Requirement id format — the 3-digit rule

Requirement ids are `KEY-NNN` where `NNN` is a **3-digit**, zero-padded ordinal
(`padStart(3)`): `CHRT-001`, `BILLING-010`, `INIT-009`. The engine's
`nextRequirementId` mints them padded to three digits; two-digit shorthand seen
in planning docs (`CHRT-01`) is a label, never a real id. Ids are permanent —
a requirement is superseded, never renumbered.

## Shadow-id promotion backlog

Several singleton command domains below are justified by **shadow ids already
cited in code comments** that have no home yet; they are promoted into their
domains during the Phase 3 hygiene pass. The backlog: **QURY-01**/QURY-02,
**RSLV-01**/RSLV-02, **SERV-01**..SERV-04, **PROP-02**/PROP-03, and their peers.
Naming them here reserves the concept so the singleton domains are not empty
shells. Phase 3 also charters two NEW domains for cross-domain shadow ids —
**PROV** (from `PROV-02`/`SC3`) and **TRK** (from `TRK-02`/`TRK-04`/`TRK-06`) —
whose ids are promoted sequentially (`PROV-001`; `TRK-001`/`TRK-002`/`TRK-003`).

---

## Per-domain charters (§4.5 target taxonomy)

Each entry gives the domain's scope sentence (lifted from §4.5), a **belongs
here** list, and a **does not belong here** list carrying at least one NAMED
boundary case.

### INDX — derivation pipeline & index lifecycle

**Scope.** The derivation pipeline and index lifecycle: cold-rebuild identity,
`build_id` determinism, structural integrity at index time, and `spec index`.
Gets POC-001, POC-003, POC-006.

- **Belongs here:** cold-rebuild equivalence (delete `.spec-engine/` → identical
  result); `build_id` determinism for identical inputs; the index-time structural
  integrity checks; `spec index` itself.
- **Does not belong here:** `spec check`'s diagnostic *severity* semantics
  (→ CHCK); the SPEC.json envelope *shape* (→ SCHM). Boundary case: cold-rebuild
  identity is an **INDX** promise even though the model it rebuilds is defined in
  SCHM.

### SCHM — shared data model

**Scope.** The shared data model: the SPEC.json envelope, the DDL, the coverage
view, and the one-model-one-seam promise ("CLI, webapp, and MCP can never
disagree — one model, one storage seam"). Gets POC-002, POC-004, POC-014.

- **Belongs here:** the `@spec-engine/shared` schema every read/write surface shares;
  the DDL; the coverage SQL view; POC-004 restated as the *promise* (one model,
  one storage seam) rather than the wiring.
- **Does not belong here:** the **drift definition** (→ PROP, POC-005 — it is the
  propagation contract, not the model); **cold-rebuild identity** (→ INDX);
  **loopback-only** binding (→ SERV). Boundary case: POC-004's one-model-one-seam
  is restated in SCHM as a promise, but cold-rebuild identity stays an INDX
  promise and loopback-only stays a SERV promise.

### CHCK — `spec check` diagnostics & CI-gate semantics

**Scope.** `spec check` diagnostics and CI-gate semantics. Gets POC-007, POC-016,
INIT-007.

- **Belongs here:** the diagnostic codes and their severities; the `--ci`
  cold-rebuild gate; which severity drives exit 1.
- **Does not belong here:** membership discovery itself (→ INIT). Boundary case:
  **check-severity semantics → CHCK even when discovery (INIT) emits the
  diagnostic** — INIT-007 defines check severity, so it lands in CHCK though the
  `NO_SPEC_CONFIG` finding originates in the discovery path.

### PROOF — trusted-red

**Scope.** Trusted-red: JUnit ingestion, PROVEN/UNPROVEN status, and rule-reproof.
Gets GATE-01..05, PROP-01.

- **Belongs here:** `--results <junit.xml>` ingestion; the PROVEN/UNPROVEN
  determination; proof-of-passing enforcement under `--ci`.
- **Does not belong here:** the bare structural gate with no results file (that is
  CHCK's plain diagnostic path). Boundary case: PROP-01 moves here and is
  **rewritten from scratch** on arrival (its Markdown-era statement fails the
  cold-read rubric — see §4.8).

### GATE — the `spec gate` approval command

**Scope.** The `spec gate` approval command. Gets POC-013.

- **Belongs here:** the pass/fail decision order (NOT_FOUND → DRAFT → SUPERSEDED
  → VERSION_PIN → PASS); pin-equality passing.
- **Does not belong here:** proof-of-passing (→ PROOF); loss detection (→ GUARD).
  Boundary case: an unknown repo name is a *usage error* (exit 2), not a gate
  failure — that contract belongs to GATE, not CHCK.

### GUARD — loss detection

**Scope.** Loss detection (unchanged): diffing the requirement derivation at a
git ref against the working tree to block requirements about to be steamrolled.
Gets GUARD-001..009 — and **GOV-01 folds in here**.

- **Belongs here:** REQUIREMENT_REMOVED / IMPL_LOST / VERIFY_LOST / SPEC_FILE_DELETED;
  the supersession + `@spec approve` suppression paths; never-fail-non-git.
  Boundary case: **GOV-01 (an Active req never disappears without approved
  supersession) folds into GUARD** — it names the same concept as GUARD-002 at a
  second enforcement point (CI/base-ref vs pre-commit/working-tree), unified on
  one diagnostic code.
- **Does not belong here:** *who may* approve a supersession (→ OWNER, the
  CODEOWNERS policy).

### OWNER — approval policy

**Scope.** Approval policy: who may retire or supersede a requirement
(CODEOWNERS). Gets GOV-02. (Renamed from GOV; GOV-03 "checks run in the gate"
dissolves into the requirements it decorated.)

- **Belongs here:** the CODEOWNERS approval policy only.
- **Does not belong here:** the *loss-detection* mechanism itself (→ GUARD).
  Boundary case: OWNER keeps only the CODEOWNERS approval policy while GOV-01's
  disappearance-detection concept moves to GUARD.

### DOMAIN — domain lifecycle

**Scope.** Domain lifecycle: `spec domain new` / `spec domain list`, and charter
editing. Gets AUTHC-001..009.

- **Belongs here:** born-valid scaffold (`spec domain new`); `domain list`
  output; the `scope` charter field on the envelope.
- **Does not belong here:** requirement authoring (→ REQ). Boundary case: minting
  a requirement id is REQ; scaffolding the domain that holds it is DOMAIN.

### REQ — requirement lifecycle

**Scope.** Requirement lifecycle: `spec req`, `spec supersede`, `spec amend`, and
`@`-refs. Gets AUTHC-010..016, AUTHC-019..024 (AUTHC-017 evicted, AUTHC-018
retired).

- **Belongs here:** next-id allocation; non-interactive authoring; supersede /
  move / amend; `@path` file-ref resolution.
- **Does not belong here:** scaffolding a whole domain (→ DOMAIN). Boundary case:
  the `spec req` prefix-resolution ladder (AUTHC-010..013) is rewritten to the
  GUARD template on migration so each statement names `spec req` and the thing
  being matched (no sibling free-riding).

### INIT — membership, discovery, onboarding

**Scope.** Membership, discovery, onboarding, and the adoption rungs. Gets
INIT-001..006, 008, 009 + POC-017.

- **Belongs here:** `spec init` pin authoring; member discovery; the
  progressive-disclosure adoption rungs (rung 1: lone repo local-only; rung 2:
  + CI gate; rung 3: + second repo = platform with shared reqs).
- **Does not belong here:** check-severity semantics (→ CHCK, INIT-007). Boundary
  case: POC-017 (adoption rungs) is superseded into three per-rung requirements,
  each independently testable, and stays in INIT.

### PROP — propagation & migration state

**Scope.** Propagation and migration state, **including the drift definition**.
Gets POC-005, POC-009 (+ future PROP-02/PROP-03).

- **Belongs here:** the per-repo migrated/drifted state; `spec propagation`; the
  drift definition itself.
- **Does not belong here:** the SPEC.json model shape (→ SCHM). Boundary case:
  **the drift definition → PROP, not SCHM** (POC-005) — it is the propagation
  contract; the SQL view computing it is merely enforcement.

### MAP — the coverage-matrix read command

**Scope.** The `spec map` requirement × repo coverage matrix. Gets POC-008.

- **Belongs here:** the matrix rows; the `src` / `test` / `src+test` / `—`
  rendering; the future webapp matrix-view requirements.
- **Does not belong here:** FTS retrieval (→ QURY). Boundary case: MAP stays a
  separate domain (not folded into a generic "read" domain) because it will
  accrue the webapp matrix-view requirements.

### QURY — the full-text retrieval read command

**Scope.** The `spec query` full-text retrieval command. Gets POC-010 (+ shadow
**QURY-01**/QURY-02).

- **Belongs here:** FTS5 `MATCH` semantics; rank-ascending results; superseded
  exclusion; `--limit` bounds.
- **Does not belong here:** file→requirement resolution (→ RSLV). Boundary case:
  a bare `AND OR` FTS5 grammar error is a QURY usage-error (exit 2) contract.

### RSLV — the file→requirement read command

**Scope.** The `spec resolve` files → requirements command (and its `--req`
reverse query). Gets POC-011 (+ shadow **RSLV-01**/RSLV-02).

- **Belongs here:** file→requirement mapping; the `--req` reverse tag-site query;
  path-containment normalization.
- **Does not belong here:** full-text search (→ QURY). Boundary case: an
  absolute path resolving outside `platformDir` is an RSLV exit-2 contract, never
  a silent `[]`.

### SERV — the local webapp / API read command

**Scope.** The `spec serve` local webapp + `/api/*` over the index. Gets POC-012
(+ shadow **SERV-01**..SERV-04).

- **Belongs here:** the SSR pages; the `/api/*` route contracts; **loopback-only**
  binding.
- **Does not belong here:** the one-model-one-seam promise (→ SCHM). Boundary
  case: **loopback-only stays a SERV promise** even though the data model it
  serves is defined in SCHM.

### PROV — provenance surface & issue-link opacity

**Scope.** The `spec provenance` matrix and the issue-link provenance model:
per-requirement creating/revising issue links surfaced beside backing tests and
the git pointer, with `issue_id` held as an opaque external payload. Gets
**PROV-001**.

- **Belongs here:** the provenance matrix rows and their sort/render; the
  `**Issues:** role:ID` parse into `(req_id, issue_id, role)`; the doctrine that
  `issue_id` is opaque — projected only, never a PK/FK/UNIQUE/index/JOIN key.
- **Does not belong here:** the tracker *fetch/cache* that resolves an issue id
  to a title (→ TRK); requirement identity/routing (issue ids are provenance,
  never identity). Boundary case: a `KEY-NNN`-shaped issue id (e.g. `BILLING-001`
  authored as an issue link) stays an opaque string in PROV and is **never**
  resolved against the `requirements` table — that opacity is a PROV promise,
  enforced by the `SC3` issue-id-opacity CI fence.

### TRK — issue-tracker integration (read-only, offline-by-default)

**Scope.** The `@spec-engine/tracker` package: the offline-default adapter and
the optional Linear read integration that resolves an opaque `issue_id` to a
title/URL for display. Gets **TRK-001, TRK-002, TRK-003**.

- **Belongs here:** the adapter interface + offline `noopAdapter`; the single
  read `query` to the tracker; the `SPEC_TRACKER_TOKEN` auth + no-token
  short-circuit; the sidecar cache; the engine-isolation boundary (engine
  internals never import the tracker; no external network from the derivation
  path).
- **Does not belong here:** the provenance matrix + issue-id opacity model itself
  (→ PROV); any write back to the tracker (forbidden — the integration is
  one-way/read-only). Boundary case: resolving an `issue_id` to a title is a TRK
  concern, but the *opacity* of that id inside the engine's index stays a PROV
  promise — TRK reads the external payload, PROV guarantees the engine never
  treats it as an identity key.

### AUTHOR — brief→mint authoring pipeline

**Scope.** The brief→mint authoring pipeline: the three surfaces that turn a
vague brief/ticket into well-formed requirements — the AGENTS.md authoring
playbook, the `.claude/skills/req-author` skill, and the `spec mcp`
`author_requirements` MCP prompt template — plus the hard constraint that the
engine stays LLM-free. Gets AUTHOR-001 (playbook), AUTHOR-002 (skill),
AUTHOR-003 (MCP prompt).

- **Belongs here:** the authoring-workflow surfaces (the AGENTS.md playbook
  section, the `req-author` skill, the `author_requirements` MCP prompt
  template) and the LLM-free engine fence.
- **Does not belong here:** the requirement-lifecycle mechanics themselves
  (`spec req` / `supersede` / `amend` → REQ), the domain scaffold
  (`spec domain new` → DOMAIN), and the charter / authoring-standard doc
  (→ CHRT). Boundary case: the `author_requirements` prompt is engine CODE,
  but it owns the authoring **template text** only — never the mint; the actual
  requirement write is REQ's promise.

### TERM — reserved glossary domain

**Scope.** The reserved glossary domain: durable TERMs — a headword, its
definition (carried in the requirement statement), aliases, and pinned cites —
that requirements reference and that are drift-checked against their pinned
version, but that are EXCLUDED from code coverage (a term is a requirement row,
never an `@spec`-tagged code obligation). Holds the 3-digit glossary data rows
TERM-001..N (Wave F); empty until then.

- **Belongs here:** glossary term entries (TERM-NNN) with their aliases and
  citations; the term-drift concern (a citation pinned behind the term's
  current version).
- **Does not belong here:** a feature requirement *about* the term store — the
  schema fields (→ SCHM), the `spec` term authoring CLI (→ REQ), the term-check
  diagnostics UNDEFINED_TERM / TERM_DRIFT (→ CHCK), the term query/lookup
  surface (→ QURY). Boundary case: the **TERM-01 schema-fields promise lives in
  SCHM** (concept wins — it protects the one-model schema), while the glossary
  **data rows TERM-001..N live here**. The two id spaces never collide: feature
  code is tagged `@spec SCHM-NNN`, glossary data is authored at `TERM-NNN`.

---

## Requirement authoring standard (§4.10)

The standard every new requirement is authored against — destined also for the
`req-author` skill. One requirement per **testable promise**, never one per
ticket.

1. **One requirement per testable promise** — never one per ticket; a brief fans
   out into several durable requirements.
2. **Template — `<command/surface> <promise> when <condition>`.** Name the
   subject explicitly (GUARD is the model domain — every GUARD requirement
   survives a cold read). Example: "spec guard reports IMPL_LOST when the last
   implementing @spec tag for an Active requirement is removed in the working
   tree."
3. **Cold-read test.** The statement must make sense alone, as seen in
   `spec query` output or the webapp — a **cold read**. Restate any referenced
   rule in a clause; no sibling free-riding ("the normalization", "an ambiguous
   prefix" with no subject); glossary terms are the only allowed jargon.
4. **Promise altitude.** Observable inputs → outputs; no function/API names or
   formatting trivia; internal symbols only when the meaning is inline (regex
   shown, file shape given).
5. **Timeless.** No "today's behavior", no references to removed things.
6. **The why carries the failure mode** — what silently breaks if the promise is
   violated; never a restatement of the statement.
7. **Anatomy triple.** **Verifying** tags = the validating tests; **livesIn** +
   **implementing** tags = the realizing files; **issue** links = **provenance**
   only (opaque to the engine — never identity, never routing). The statement is
   the input→output promise; the tests validate it; the files realize it.
8. **Placement.** Concept-wins per the domain charter above; run `spec query`
   first to dedup against existing requirements.

---

## Headline invariants (§4.8) — by post-reorg domain

The six invariants historically cited as "(Invariant #N)" across POC rationales
and code comments, presented here by the domain each lands in after the reorg.
The former POC ids are shown for provenance; the **successor id** column carries
the real `KEY-NNN` each Phase 2 `spec move` minted:

| # | Former id | Post-reorg domain | Successor id | Invariant |
|---|-----------|-------------------|--------------|-----------|
| 1 | POC-001 | **INDX** | **INDX-001** | Cold-rebuild identity — deleting `.spec-engine/` and rebuilding yields an identical result. |
| 2 | POC-016 | **CHCK** | **CHCK-002** | `spec check --ci` builds fresh — correctness never trusts a cached or warm index. |
| 3 | POC-002 | **SCHM** | **SCHM-001** | One shared schema — every read/write surface validates the same envelope. |
| 4 | POC-003 | **INDX** | **INDX-002** | `build_id` is deterministic for identical inputs (cold-rebuild equivalence). |
| 5 | POC-004 | **SCHM** | **SCHM-002** | One model, one storage seam — CLI, webapp, and MCP can never disagree. |
| 6 | POC-005 | **PROP** | **PROP-002** | The drift definition is the propagation contract, computed by a SQL view. |

**Id-reconcile note (Phase 2) — CLOSED.** The successor `KEY-NNN` values are now
**reconciled**: the six cross-domain supersessions landed via `spec move` and the
Successor id column above carries their real ids — #1 POC-001 → **INDX-001**,
#2 POC-016 → **CHCK-002**, #3 POC-002 → **SCHM-001**, #4 POC-003 → **INDX-002**,
#5 POC-004 → **SCHM-002**, #6 POC-005 → **PROP-002** (each the authoritative
`supersededBy` on the POC source envelope). Phase 1 chartered the domains; Phase 2
performed the supersessions and retag worklists — this note closes the CHRT-06
loop. Note that the ROADMAP shorthand "INDX/SCHM/PROP" undercounts **CHCK** (for
POC-016); §4.5/§4.8 is the DECIDED evidence table and is authoritative here.
