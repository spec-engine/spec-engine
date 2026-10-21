// The glob matcher is a linear segment walker and never builds a RegExp from
// CODEOWNERS text, so untrusted authored patterns cannot drive catastrophic
// backtracking.

export interface CodeownersRule {
  pattern: string;
  owners: string[];
}

// Authored order is preserved: ownersForPath depends on it for last-match-wins.
// @spec OWNER-002
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.split("\n")) {
    const hash = raw.indexOf("#");
    const body = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    if (body === "") continue;
    const [pattern = "", ...owners] = body.split(/\s+/);
    rules.push({ pattern, owners });
  }
  return rules;
}

// GitHub semantics: the last matching rule wins, not the first and not the
// most specific, so this must not become a `.find`.
export function ownersForPath(rules: readonly CodeownersRule[], relPath: string): string[] {
  let winner: CodeownersRule | null = null;
  for (const rule of rules) {
    if (matchesGlob(rule.pattern, relPath)) winner = rule;
  }
  return winner ? winner.owners : [];
}

export function matchesGlob(pattern: string, relPath: string): boolean {
  let pat = pattern;
  if (pat.startsWith("/")) pat = pat.slice(1);

  // A bare `*` is GitHub's global-owner rule. Without this the single-segment
  // walker would length-mismatch any nested path, a `* @fallback-owner` rule
  // would own nothing, and every flip would read as UNAPPROVED_STATUS_FLIP.
  if (pat === "*" || pat === "**" || pat === "**/") return true;

  let subtree = false;
  if (pat.endsWith("/**")) {
    pat = pat.slice(0, -3);
    subtree = true;
  } else if (pat.endsWith("/")) {
    pat = pat.slice(0, -1);
    subtree = true;
  }

  const patSegs = pat.split("/").filter((s) => s.length > 0);
  const pathSegs = relPath.split("/").filter((s) => s.length > 0);

  if (subtree) {
    return pathSegs.length >= patSegs.length && prefixSegmentsMatch(patSegs, pathSegs);
  }

  return patSegs.length === pathSegs.length && prefixSegmentsMatch(patSegs, pathSegs);
}

// The caller guarantees `pathSegs` has at least `patSegs.length` entries and
// owns the length policy (exact vs subtree).
function prefixSegmentsMatch(patSegs: readonly string[], pathSegs: readonly string[]): boolean {
  for (let i = 0; i < patSegs.length; i++) {
    if (!matchesSegment(patSegs[i] ?? "", pathSegs[i] ?? "")) return false;
  }
  return true;
}

// Backtracking is anchored to the last `*` only, which bounds the walk.
function matchesSegment(pat: string, seg: string): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let sBacktrack = 0;
  while (s < seg.length) {
    if (p < pat.length && pat[p] === "*") {
      star = p;
      sBacktrack = s;
      p++;
    } else if (p < pat.length && pat[p] === seg[s]) {
      p++;
      s++;
    } else if (star !== -1) {
      p = star + 1;
      sBacktrack++;
      s = sBacktrack;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}
