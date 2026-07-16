// packages/engine/src/guard/directives.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec GUARD-007
//
// The `@spec approve KEY-NNN <reason>` escape-hatch parser — the
// deliberate, in-diff override that suppresses a loss `spec guard` would
// otherwise report. Same UX as a `biome-ignore` comment: an explicit
// acknowledgement plus a MANDATORY human reason, so a requirement never dies
// silently but CAN die when someone means it.
//
// This does NOT collide with the `@spec KEY-NNN [level]` tag scanner
// (scanner/tags.ts): that grammar requires an uppercase requirement id
// immediately after `@spec`, whereas `approve` is a lowercase keyword, so the
// tag scanner never matches an approve directive and the approve scanner never
// matches a binding tag. The two grammars are disjoint by construction.
//
// PURITY: text in, rows out. No I/O, no Storage, no bun:sqlite (D-08 fence).

/** One parsed `@spec approve` directive: the acknowledged requirement id plus
 *  the mandatory human reason (verbatim, trimmed). */
export interface Approval {
  req_id: string;
  reason: string;
}

/**
 * The approve grammar: `@spec approve KEY-NNN <reason>`. The reason capture is
 * `\S.*` — it must begin with a non-space char, so a bare `@spec approve
 * GUARD-002` with no reason does NOT match (mirroring biome-ignore's required
 * explanation). No `g` flag: the scanner tests one line at a time, so there is
 * no sticky-lastIndex state to reset. Linear-time (no nested quantifier) —
 * ReDoS-safe on adversarial input.
 */
export const APPROVE_RE = /@spec\s+approve\s+([A-Z][A-Z0-9]*-\d+)\s+(\S.*)$/;

/**
 * Scan `text` for `@spec approve` directives, one row per matching line. Comment
 * style is irrelevant (the token is matched anywhere on the line), matching the
 * tag scanner's design. A line without a reason is ignored — an unreasoned
 * approve is not an approve.
 */
export function scanApprovals(text: string): Approval[] {
  const out: Approval[] = [];
  for (const line of text.split("\n")) {
    const m = APPROVE_RE.exec(line);
    if (m !== null) {
      out.push({ req_id: m[1] as string, reason: (m[2] as string).trim() });
    }
  }
  return out;
}
