// packages/engine/src/server/authorPrompt.ts
//
// L4 (lifecycle pass) — the static authoring-playbook template behind the
// `spec mcp` author_requirements prompt. This is a PURE template renderer:
// static {brief}/{domain}/{charter} substitution ONLY — no I/O, no fetch, no
// model call, no Date, no randomness — so the same inputs always produce the
// same bytes (snapshot-stable). The engine returns the filled template; the
// MCP CLIENT's model is what consumes and runs it. That is the phase's hard
// constraint: the engine stays LLM-free (enforced by fence_llmfree_engine).
//
// The full authoring standard lives in spec-engine/TAXONOMY.md — this file
// carries the operational step sequence (the command choreography) plus the
// EARS shapes, because a statement's shape is checked mechanically at write
// time and the prompt must teach the same shape the validator enforces.

/**
 * Render the authoring playbook for a brief. Three charter branches:
 *   - charter present → "Target domain: <D>" + the charter/scope text
 *   - domain given but no charter → the domain-named "check placement" branch
 *   - no domain → the "determine placement from `spec domain list`" branch
 * Pure string assembly — deterministic and byte-stable.
 */
// @spec AUTHOR-003
export function renderAuthorPrompt(opts: {
  brief: string;
  domain?: string;
  charter: string | null;
}): string {
  const charterBlock = opts.charter
    ? `\nTarget domain: ${opts.domain}\nDomain charter (scope): ${opts.charter}\n`
    : opts.domain
      ? `\nTarget domain: ${opts.domain} (no charter/scope recorded — check placement carefully)\n`
      : "\nNo target domain given — determine placement from `spec domain list`.\n";
  return [
    "You are authoring Spec Engine requirements from a brief. Follow this playbook exactly.",
    charterBlock,
    "Brief:",
    opts.brief,
    "",
    "Steps:",
    "1. One requirement per behavior — never one per ticket; a brief fans out into several.",
    "2. Placement: the domain whose promise the requirement protects (see the charter above); run `spec query <text>` first — if a close requirement exists, amend or relate it instead of minting.",
    '3. Draft each statement in one of the five EARS shapes ("shall" separates who acts from the observable result): `The <system> shall <result>` / `When <trigger>, the <system> shall <result>` / `While <state>, …` / `If <failure>, then …` / `Where <feature>, …`. Example: "When an unknown id is passed, spec resolve shall print [] and exit 0."',
    "4. Self-check: the statement makes sense read alone; it describes what the system does, not how the code does it; no expiration dates ('currently', removed things); the why names what breaks if the promise stops holding — never a restatement.",
    "5. Tie each draft to its source: quote the exact phrase of the brief it derives from; label anything you inferred as inferred.",
    "6. Present the full batch (statement, why, placement, source quote) for approval BEFORE writing.",
    '7. Mint each approved requirement: `spec req <domain> --text "…" --why "…" --lives "…"`.',
    "8. The originating ticket is provenance only — never a requirement id, never a code tag.",
  ].join("\n");
}
