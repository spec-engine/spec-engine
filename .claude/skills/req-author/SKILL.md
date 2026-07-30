---
name: req-author
description: Turn a rough brief or ticket into Spec Engine requirements — draft them in the fixed EARS shape, tie every draft to the exact words it came from, present the batch for human approval, and only then mint via the real `spec` CLI.
---

# req-author

This skill drives the real `spec` CLI (`spec req`, `spec query`,
`spec domain list`) and never reimplements minting. It is the front half of
the lifecycle: brief in, approved requirements out; the route → tag → check
loop consumes what it produces.

**Two non-negotiable rules:**

1. **Never write without approval.** Draft, self-check, present the batch —
   then STOP. No `spec req` runs until the human explicitly approves.
2. **Every draft quotes its source.** Each drafted requirement carries the
   exact phrase from the brief it derives from, verbatim. A requirement you
   cannot anchor to the author's words is labeled **inferred** so the human
   can accept or reject the inference knowingly. This exists because
   agent-drafted requirements have shipped that the product owner could not
   trace back to anything they said.

## Procedure

1. **Read the brief.** A ticket is temporary work; the requirements outlive
   it. One brief usually splits into several requirements — one per behavior,
   never one per ticket.

2. **Draft each requirement in the fixed shape.** Every statement uses one of
   the five EARS shapes (the word "shall" separates who acts from the
   observable result):

   | Situation | Shape |
   |---|---|
   | Always true | The `<system>` shall `<result>` |
   | Triggered by an event | When `<trigger>`, the `<system>` shall `<result>` |
   | Only in a certain state | While `<state>`, the `<system>` shall `<result>` |
   | Handling something going wrong | If `<failure>`, then the `<system>` shall `<result>` |
   | Only when a feature is present | Where `<feature>`, the `<system>` shall `<result>` |

   Example: "When an unknown requirement id is passed, spec resolve shall
   print [] and exit 0." If a draft fits no row, you have not yet decided
   what triggers the behavior or what observably happens — decide, or mark
   the draft as a question for the human.

3. **Write a why that names what breaks.** The `why` answers "what goes wrong
   if this stops being true" — never a restatement of the statement in
   different words.

4. **Place and dedup.** `spec domain list --json` shows every domain's
   charter; put each requirement in the domain whose promise it protects (not
   where the code file sits). Then `spec query "<phrase>" . --json` — if a
   close requirement already exists, propose amending or relating it instead
   of a new id.

5. **Present the batch and STOP.** For each candidate show: the domain, the
   statement, the why, the `livesIn` file, and the **source quote** (or the
   `inferred` label). Write nothing until the human approves. This gate is
   mandatory.

6. **On approval, mint via the real CLI:**

   ```
   spec req <domain> --text "<statement>" --why "<what breaks>" --lives "<file>"
   ```

   (or the equivalent `spec mcp` tools). `spec req` validates through the one
   shared schema — in a domain that declares the ears grammar it also checks
   the statement shape at write time, and with `--json` it returns the parsed
   clauses.

7. **Record the ticket as provenance only.** The originating ticket id is
   history, never a requirement id and never a code `@spec` tag.

8. **Verify.** `spec index . && spec check . --ci` (exit 0) and
   `spec guard .` (no loss) before the change ships.

## Invocation note

The repo's `.mcp.json` registers the local `spec mcp` server (stdio,
loopback), so the tools and the `author_requirements` prompt are callable
natively from the harness. From a source checkout the server runs as
`bun packages/engine/src/cli.ts mcp .`; a compiled `spec` binary on PATH runs
as `spec mcp .`.
