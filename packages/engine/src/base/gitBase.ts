// packages/engine/src/base/gitBase.ts
//
// GOV-01/GOV-02/PROP-01 (20-03): the command-tier git base-ref I/O helper. This
// is the ONE git subprocess seam the governance/propagation gate uses to read
// the PRIOR domain JSON so `spec check --base <ref>` can diff base→change.
//
// Two readers:
//   gitShow(platformDir, ref, relPath)  — the bytes at `<ref>:<relPath>`, or
//                                         null when the path is absent at that
//                                         ref (a newly-added file has no base).
//   gitLsTree(platformDir, ref, dir)    — the repo-relative paths under `dir`
//                                         at `<ref>` (recursive, names only).
//                                         Enumerating from the ref (NOT the
//                                         working tree) is what makes a
//                                         whole-domain-file DELETION still
//                                         surface its removed ids (Pitfall 3).
//
// SECURITY — T-20-01 ref-injection (Tampering / EoP): `ref` is untrusted
// CLI/CI-supplied input. It is validated against `^[A-Za-z0-9._/-]+$` BEFORE any
// spawn — an unsafe ref (space, leading `-` that git would read as a flag, or a
// shell metacharacter like `;`/`|`/`$`) is rejected with null / [] and git is
// NEVER spawned. Every call passes an ARGV ARRAY to `Bun.spawnSync` — there is
// no shell, so even a validated ref cannot be word-split or interpolated. The
// `--` separator precedes the path in ls-tree so a path can never be read as an
// option.
//
// PURITY: Bun built-ins only (Bun.spawnSync) — no bun:sqlite, no Storage, no DB.
// The D-08 engine-internal fence covers this file (no SQLite runtime import).

/**
 * Allow-shape for a git ref: alphanumerics plus `.`, `_`, `/`, `-`. This
 * deliberately rejects whitespace, shell metacharacters, and a leading `-`
 * word (git would treat `--upload-pack=…` / `-foo` as an option). A ref that
 * fails this test never reaches a spawn.
 */
function isSafeRef(ref: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(ref);
}

/**
 * The platform dir's path relative to its git repo root, with a trailing slash
 * (empty string when the platform IS the repo root, or when it is not inside a
 * git work tree). This is the offset that makes the git seam correct when the
 * platform lives BELOW the repo root (1.2).
 *
 * `git diff` / `ls-tree` / `show` all speak REPO-ROOT-relative paths, whereas
 * the guard/check collectors and the derived index speak PLATFORM-relative
 * paths (e.g. `spec-engine/FOO/SPEC.json`). Without translating between the two,
 * a platform nested one level below the repo root would make every changed
 * spec/code file miss the `spec-engine/` filter — the loss guard would see zero
 * changes and pass silently (fail-open). Every path crossing this seam is
 * translated through this prefix so the nested case is handled correctly.
 *
 * `git rev-parse --show-prefix` prints `sub/dir/` (trailing slash) from a
 * subdirectory and an empty line at the repo root; `.trim()` drops only the
 * newline (a `/` is not whitespace). Not cached — a fresh spawn per call keeps
 * it correct if the tree's git state changes mid-process (tests re-init repos).
 */
export function gitRepoPrefix(platformDir: string): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--show-prefix"], { cwd: platformDir });
  if (proc.exitCode !== 0) return "";
  return proc.stdout.toString().trim();
}

/**
 * Return true iff `ref` passes the allow-shape AND resolves to a commit in
 * `platformDir`'s git repository. This is the fail-CLOSED guard for the
 * governance gate: `gitShow`/`gitLsTree` cannot distinguish "path absent at a
 * valid ref" (a benign skip) from "ref/repo unreadable" (both exit non-zero and
 * yield null/[]), so an unresolvable `--base` ref would otherwise make every
 * governance check silently no-op and the gate exit GREEN when it should be RED
 * (fail-open authorization). The command MUST call this before diffing and treat
 * a false result as a usage error (exit 2), NOT an empty base.
 *
 * `--verify --quiet` + the `^{commit}` peel means a tag/branch/sha all resolve,
 * while a typo, an unfetched ref (e.g. `origin/main` on a shallow checkout), or
 * a non-git `platformDir` all return false. Never throws.
 */
export function gitRefResolves(platformDir: string, ref: string): boolean {
  if (!isSafeRef(ref)) return false;
  const proc = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: platformDir,
  });
  return proc.exitCode === 0;
}

/**
 * Return the file bytes at `<ref>:<relPath>`, or null when the path is absent at
 * that ref (git exits non-zero) or the ref fails the allow-shape. Never throws.
 * `relPath` is PLATFORM-relative; the repo-root prefix is prepended so a nested
 * platform reads the correct blob (1.2). NOTE: a null here is AMBIGUOUS (absent
 * path vs unreadable ref/repo) — callers that need the distinction MUST gate on
 * `gitRefResolves` first (see CR-01).
 */
export function gitShow(platformDir: string, ref: string, relPath: string): string | null {
  if (!isSafeRef(ref)) return null;
  const full = `${gitRepoPrefix(platformDir)}${relPath}`;
  const proc = Bun.spawnSync(["git", "show", `${ref}:${full}`], { cwd: platformDir });
  if (proc.exitCode !== 0) return null;
  return proc.stdout.toString();
}

/**
 * Return the PLATFORM-relative paths under `dir` at `<ref>` (recursive, names
 * only), or [] when the ref fails the allow-shape or git exits non-zero. `dir`
 * is PLATFORM-relative; the repo-root prefix is prepended for the git pathspec
 * and stripped back off each returned path so callers always see
 * platform-relative names regardless of where the platform sits in the repo
 * (1.2). Trims each line and drops empties. Never throws.
 */
export function gitLsTree(platformDir: string, ref: string, dir: string): string[] {
  if (!isSafeRef(ref)) return [];
  const prefix = gitRepoPrefix(platformDir);
  const proc = Bun.spawnSync(
    ["git", "ls-tree", "-r", "--name-only", ref, "--", `${prefix}${dir}`],
    { cwd: platformDir },
  );
  if (proc.exitCode !== 0) return [];
  return proc.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => (prefix.length > 0 && l.startsWith(prefix) ? l.slice(prefix.length) : l));
}

/** One `git diff --name-status` row: a single-letter change status and the
 *  repo-relative path it applies to. `status` is `A` (added), `M` (modified),
 *  `D` (deleted), `T` (type-changed), etc. — the raw git letter, uppercased. */
export interface DiffEntry {
  status: string;
  path: string;
}

/**
 * Return the `<ref>`→working-tree diff as `{status, path}` rows (GUARD-01): the
 * cheap change scope `spec guard` diffs derivations over. `--no-renames` forces
 * a rename to surface as a `D` of the old path plus an `A` of the new one, so a
 * moved requirement/tag is never hidden behind an `R` (the whole-file-deletion
 * signal SPEC_FILE_DELETED / IMPL_LOST depend on). `--relative` restricts the
 * diff to the platform subtree AND rewrites each path to be PLATFORM-relative,
 * so a platform nested below the repo root still classifies its changed
 * spec/code files instead of failing open (1.2). Only TRACKED files appear —
 * an untracked new file cannot delete a prior requirement, so its absence here
 * is correct. `[]` when the ref fails the allow-shape or git exits non-zero
 * (the caller has already gated on `gitRefResolves`, so a clean tree also
 * yields `[]`). Never throws.
 *
 * SECURITY — T-20-01 parity: `ref` is validated against the same allow-shape as
 * the other readers BEFORE any spawn, and passed as an ARGV element (no shell),
 * so it can never be word-split or read as an option.
 */
export function gitDiffNameStatus(platformDir: string, ref: string): DiffEntry[] {
  if (!isSafeRef(ref)) return [];
  const proc = Bun.spawnSync(["git", "diff", "--name-status", "--no-renames", "--relative", ref], {
    cwd: platformDir,
  });
  if (proc.exitCode !== 0) return [];
  const rows: DiffEntry[] = [];
  for (const line of proc.stdout.toString().split("\n")) {
    if (line.length === 0) continue;
    // "<status>\t<path>" — the status token is the first tab-delimited field,
    // the path the last (a bare `M\tfoo.ts`; renames are split off by
    // --no-renames so there is never a second path column to disambiguate).
    const parts = line.split("\t");
    const status = (parts[0] ?? "").trim().toUpperCase();
    const path = (parts[parts.length - 1] ?? "").trim();
    if (status.length === 0 || path.length === 0) continue;
    rows.push({ status, path });
  }
  return rows;
}
