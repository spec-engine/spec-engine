---
name: req-author
description: Turn a vague brief or ticket into well-formed spec-check requirements — draft a batch against the §4.10 standard, present it for human approval, and only then mint via the real `spec` CLI.
---

# req-author

The executable form of the AGENTS.md `## Authoring requirements (brief → mint)`
playbook. This skill **dogfoods the real `spec` CLI** — it drives `spec req`,
`spec query`, and `spec domain list`, and NEVER reimplements minting. It is the
mint front-half of the lifecycle; the route → tag → check loop then consumes
what it produces.

**Non-negotiable contract: this skill never writes without approval.** It drafts,
self-checks, and PRESENTS a batch — then STOPS. No `spec req` (a corpus write)
runs until the human explicitly approves the batch.

## Procedure

1. **Read the brief.** Take the raw brief/ticket as input. Note that a ticket is
   ephemeral provenance, never a requirement id.

2. **Draft a batch.** Fan the brief out into candidate requirements following the
   AGENTS.md `## Authoring requirements (brief → mint)` sequence: **one
   requirement per testable promise, never one per ticket.** Write each to the
   GUARD template — `<command/surface> <promise> when <condition>`.

3. **Place each.** Run `spec domain list --json` to see every domain's scope and
   assign each candidate concept-wins per the domain charter. Run
   `spec query "<phrase>" . --json` to dedup against existing requirements —
   overlap means `spec amend`/relate, not a new id.

4. **Self-check each statement against §4.10.** Run the cold-read rubric on every
   draft: see `spec-engine/TAXONOMY.md` §4.10 for the eight-point authoring
   standard (subject named, cold-read-standalone, promise altitude, timeless,
   the `why` carries the failure mode). Cross-reference that single source — do
   NOT re-author the rubric here.

5. **Present the batch and STOP — approval gate.** Show the human the full batch:
   for each candidate its domain placement, statement, `why` (failure mode), and
   `livesIn`. Write NOTHING until the human approves. This is the approval-
   before-writing gate and it is mandatory.

6. **On approval, mint via the real CLI.** For each approved candidate run:

   ```
   spec req <domain> --text "<statement>" --why "<failure mode>" --lives "<file>"
   ```

   (or the equivalent `spec mcp` tools). Never a JS reimplementation of minting —
   `spec req` validates through the one shared schema and is the single source of
   the write.

7. **Provenance only.** Record the originating ticket as `Issues:` provenance —
   never a requirement id, never a code `@spec` tag.

8. **Verify.** After minting, `spec index . && spec check . --ci` (exit 0) and
   `spec guard .` (no loss) before the change ships.

## Invocation note

The repo's `.mcp.json` registers the local `spec mcp` server (stdio, loopback),
so the tools — and, once it lands, the `author_requirements` prompt — are
callable natively from the harness. From a source checkout the server runs as
`bun packages/engine/src/cli.ts mcp .`; a compiled `spec` binary on PATH runs as
`spec mcp .`.
