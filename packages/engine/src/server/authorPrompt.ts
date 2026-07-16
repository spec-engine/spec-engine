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
// The rubric itself is single-sourced in spec-engine/TAXONOMY.md §4.10 — this
// file carries the OPERATIONAL step sequence (the command choreography), not a
// re-authored rubric.

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
    "You are authoring spec-check requirements from a brief. Follow this playbook exactly.",
    charterBlock,
    "Brief:",
    opts.brief,
    "",
    "Steps:",
    "1. One requirement per TESTABLE PROMISE — never one per ticket; a brief fans out.",
    "2. Placement: concept-wins per the domain charter above; run `spec query <text>` first to dedup.",
    "3. Draft each to the GUARD template: `<command/surface> <promise> when <condition>` — name the subject explicitly.",
    "4. Cold-read self-check: the statement must stand alone (restate referenced rules; no sibling free-riding; glossary terms only); timeless; observable inputs→outputs; the why carries the failure mode. See spec-engine/TAXONOMY.md §4.10 for the eight-point standard.",
    "5. Present the full batch for approval BEFORE writing.",
    '6. Mint each approved requirement: `spec req <domain> --text "…" --why "…" --lives "…"`.',
    "7. The originating ticket is `Issues:` PROVENANCE ONLY — never a requirement id, never a code tag.",
  ].join("\n");
}
