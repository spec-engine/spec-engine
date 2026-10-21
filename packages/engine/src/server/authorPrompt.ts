// Pure template: no I/O, model call, Date, or randomness, so output is
// byte-stable and the engine stays LLM-free (fence_llmfree_engine). The EARS
// shapes are repeated here because the prompt must teach the shape the
// write-time validator enforces; the full standard is spec-engine/TAXONOMY.md.

// @spec AUTHOR-008
// @spec AUTHOR-009
export function renderAuthorPrompt(opts: {
  brief: string;
  domain?: string | undefined;
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
