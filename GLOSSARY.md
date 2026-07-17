# Glossary

Canonical names for Spec Engine concepts. When prose, code comments, diagnostics, or
docs need one of these ideas, use the term below — not a synonym. Terms are ordered
by the data model, outside-in.

## The three core nouns — not interchangeable

- **Domain** — a named *subject area* of requirements, keyed by an UPPERCASE key (`BILLING`, `GUARD`). A domain is the concept: it has an owner, a charter (what belongs in it, what doesn't), and a set of requirements. Use "domain" when talking about grouping, taxonomy, or ownership.
- **Spec** — the *artifact* that records one domain's requirements: the `spec-engine/<KEY>/SPEC.json` file (the "domain envelope"). One spec per domain. Use "spec" when talking about the file or its schema. A requirement domain's version is not authored on the spec — it is derived from the supersede DAG; only the reserved TERM domain carries an authored `specVersion`, the pin term-drift is measured against.
- **Requirement** — the atomic, durable unit: a permanent id (`KEY-NNN`), a statement, a rationale (`why`), and a lifecycle status. Requirements are superseded, never deleted or renumbered. You **charter** a domain and **supersede** a requirement; a spec's version follows from the supersede history rather than being authored.

## Platform structure

- **Platform** — a directory containing a canonical `spec-engine/` plus the member repos beside it. The unit `spec map` / `spec check` operate on.
- **Canonical spec repo** — the `spec-engine/` directory: the only source of truth. Everything else is derived from it plus tags.
- **Member** — a repo that opts into the platform by carrying a `spec-engine.member.json` pinning a spec-engine version.
- **Pin** — a member's declared spec-engine version (`"specs": "spec-engine@N"`). N is one platform-wide scalar compared, for each requirement the member's tags reference, against that requirement's `changed_at_version` — the version, derived locally within the owning domain's supersede DAG, at which the requirement last changed; a referenced requirement whose `changed_at_version` exceeds the pin is drift. Cross-domain caveat: domains version independently, so the single scalar spans them all and names no one platform state — a pin covers changes through version N in every domain at once. Pinning current means the derived platform version (the max domain version), the default `spec init` writes.
- **Adoption rungs** — progressive disclosure of the tool: rung 1, a lone repo self-consumes locally; rung 2, adds the CI gate; rung 3, a second repo onboards and the directory becomes a platform with shared requirements.

## Binding code to requirements

- **Tag** — a `@spec KEY-NNN` comment binding a source line to a requirement.
- **Tag kind** — derived from the file path, never written in the tag: a tag in implementation code **implements**; in a test path **verifies**; in docs **documents**. Test tags may carry a level token (`unit` | `integration` | `e2e`).
- **livesIn** — a requirement field listing where it is *enforced* (`@<path>` refs). Metadata, not identity: a requirement belongs to the domain whose promise it protects, wherever the enforcing code lives.

## Requirement lifecycle

- **Statuses** — `active` (in force), `draft` (not yet approved), `superseded` (replaced by a successor), `retired` (deliberately ended, no successor).
- **Supersede** — the only legal way an active requirement stops applying with a successor: mints the new id, marks the old `supersededBy`, and emits the retag worklist. The supersede edge is what advances the domain's derived version; on the reserved TERM domain it also bumps the authored `specVersion`.
- **Amend** — in-place revision of an unshipped entry's fields; same id, no version bump.
- **Retire** — deliberate end-of-life without a successor; requires owner approval.

## Derived machinery

- **Derived index** — the disposable `.spec-engine/index.sqlite` built from the canonical specs + tags. Owns nothing; deleting it is always safe.
- **Coverage** — the requirement × repo matrix (implemented / verified per cell), computed as a SQL view over tags — never authored.
- **Drift** — a member pinned to a spec version older than the version in which a requirement it references changed.
- **Propagation** — per-member migration state for a superseded requirement (who moved to the successor, who is stuck).
- **build_id** — deterministic hash of the index's canonical projection; byte-identical across cold rebuilds of identical inputs.
- **Cold reset** — wiping the derived index so nothing warm is trusted (`check --ci`, `gate`, `--fresh`). In-place and inode-preserving, so live readers stay correct.
- **Diagnostic** — one finding from `spec check` (`DANGLING_TAG`, `DRIFT`, `ORPHAN_REQ`, …), with `error` or `warning` severity.

## Enforcement surfaces

- **Check** — `spec check`: point-in-time integrity of the platform as it is now.
- **Guard** — `spec guard`: loss detection for a *change* — blocks deleting an active requirement, its last implementation, or its last test without supersession.
- **Gate** — `spec gate`: the approval primitive — passes only when the requirement is active and the member's pin covers it.
- **Trusted-red / PROVEN** — proof-of-passing: with `--results <junit.xml>`, an active requirement counts as proven only via a *passing* verifying test; a tag on a red or missing test fails the gate.

## Meta

- **Charter** — (a domain's *scope*) — the statement of what belongs in a domain and what doesn't. Lives with the domain; consulted at authoring time.
- **Shadow id** — a requirement-shaped id cited in code comments or CI fences that exists in no spec (e.g. `SCHM-07`). Debt: either promote it into a real requirement or remove the citation.
- **Issue** — a tracker ticket (Linear/Jira/GitHub): an ephemeral work event. One issue typically fans out into several durable requirements. Issue links on a requirement are provenance, never identity — never tag code with an issue id.
