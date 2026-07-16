// packages/engine/src/check/codeowners.ts
//
// GOV-02: the pure CODEOWNERS grammar — turns authored `.github/CODEOWNERS`
// text into ordered rules, and resolves a repo-relative path to its owning
// handles with GitHub's LAST-match-wins semantics (Pitfall 4). Used by the
// status-flip gate (Plan 20-02) to decide whether a superseded/retired flip
// carries its domain owner's approval.
//
// Analog: results/junit.ts — text in, structured out, no dependency, no I/O.
// The caller reads the CODEOWNERS file and passes the text in; this module
// never touches the filesystem.
//
// SECURITY — ReDoS-immune by construction (T-20-03, mirrors T-17-02): the glob
// matcher is a LINEAR segment walker. It NEVER constructs a dynamic regular
// expression from a CODEOWNERS pattern — untrusted authored text can never
// drive catastrophic backtracking. `*` matches within a single path segment
// only and does not cross `/`.
//
// D-08 grep-fence: this file imports no SQLite runtime — no Storage, no DB.

export interface CodeownersRule {
  pattern: string;
  owners: string[];
}

/**
 * Parse CODEOWNERS text into ordered rules. Per line: strip a `#`-comment tail,
 * trim, skip empty; split the remainder on whitespace into `[pattern,
 * ...owners]`. Authored order is preserved (ownersForPath depends on it for
 * last-match-wins). A pattern with no trailing owners yields `owners: []`.
 */
// @spec OWNER-001
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.split("\n")) {
    const hash = raw.indexOf("#");
    const body = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    if (body === "") continue;
    const [pattern, ...owners] = body.split(/\s+/);
    rules.push({ pattern, owners });
  }
  return rules;
}

/**
 * Resolve the owners of a repo-relative path with LAST-match-wins semantics:
 * iterate ALL rules, keeping the last whose pattern matches (NOT `.find`, NOT
 * most-specific). Unmatched → `[]`.
 */
export function ownersForPath(rules: readonly CodeownersRule[], relPath: string): string[] {
  let winner: CodeownersRule | null = null;
  for (const rule of rules) {
    if (matchesGlob(rule.pattern, relPath)) winner = rule;
  }
  return winner ? winner.owners : [];
}

/**
 * Linear gitignore-style segment matcher. NO dynamic regular expression built
 * from pattern text (ReDoS-safe):
 *   - a leading `/` anchors to root (stripped — patterns are already
 *     repo-relative here);
 *   - a trailing `/` (or `/**`) matches the whole directory subtree;
 *   - `*` matches within a single segment and does NOT cross `/`;
 *   - segments are compared one-for-one.
 */
export function matchesGlob(pattern: string, relPath: string): boolean {
  let pat = pattern;
  // A leading slash anchors to root; paths here are already root-relative.
  if (pat.startsWith("/")) pat = pat.slice(1);

  // WR-04: a bare `*` (or `**` / `**/`) is GitHub's global-owner rule — it
  // matches EVERY path. Without this the single-segment `*` walker would
  // length-mismatch any nested path and a `* @fallback-owner` rule would own
  // nothing (fail-closed → spurious UNAPPROVED_STATUS_FLIP). Trailing-slash
  // subtree ownership below still requires the slash (documented GitHub rule).
  if (pat === "*" || pat === "**" || pat === "**/") return true;

  // Trailing `/` or `/**` → directory-subtree match: everything under the dir.
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
    // The path must have at least the prefix segments, each matching.
    return pathSegs.length >= patSegs.length && prefixSegmentsMatch(patSegs, pathSegs);
  }

  // Exact segment-count file match.
  return patSegs.length === pathSegs.length && prefixSegmentsMatch(patSegs, pathSegs);
}

/**
 * Compare each pattern segment one-for-one against the same-index path segment
 * (`patSegs[i]` vs `pathSegs[i]`). The caller guarantees `pathSegs` has at least
 * `patSegs.length` entries — this walks only the pattern's prefix and leaves the
 * length policy (exact vs subtree) to `matchesGlob`.
 */
function prefixSegmentsMatch(patSegs: readonly string[], pathSegs: readonly string[]): boolean {
  for (let i = 0; i < patSegs.length; i++) {
    if (!matchesSegment(patSegs[i], pathSegs[i])) return false;
  }
  return true;
}

/**
 * Match ONE path segment against ONE pattern segment where `*` is a
 * within-segment wildcard. Two-pointer greedy walk with backtrack anchored to
 * the last `*` — bounded and linear-ish in the segment length (no regex, no
 * catastrophic backtracking across the whole path).
 */
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
