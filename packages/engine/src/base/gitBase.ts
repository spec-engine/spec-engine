// The one git subprocess seam for the governance and propagation gates.
//
// `ref` is untrusted CLI/CI input: it is checked against the allow-shape before
// any spawn, and every call passes an argv array (no shell), so a ref can never
// be word-split, interpolated, or read as an option. The base is enumerated
// from the ref, not the working tree, so a deleted domain file still surfaces
// its removed ids.

// @spec GUARD-027
export function isSafeRef(ref: string): boolean {
  return /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(ref);
}

/**
 * The platform dir's path relative to its git repo root, with a trailing slash
 * (empty at the repo root or outside a git work tree).
 *
 * git speaks repo-root-relative paths; the collectors and the index speak
 * platform-relative ones. Without translating through this prefix, a platform
 * nested below the repo root would make every changed file miss the
 * `spec-engine/` filter and the loss guard would pass silently (fail-open).
 *
 * Not cached: a fresh spawn per call stays correct if the tree's git state
 * changes mid-process (tests re-init repos).
 */
export function gitRepoPrefix(platformDir: string): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--show-prefix"], { cwd: platformDir });
  if (proc.exitCode !== 0) return "";
  return proc.stdout.toString().trim();
}

/**
 * The fail-closed guard for the governance gate: `gitShow`/`gitLsTree` cannot
 * tell "path absent at a valid ref" from "ref or repo unreadable" (both yield
 * null/[]), so an unresolvable `--base` would make every governance check
 * silently pass. Callers must check this first and treat false as a usage
 * error, not an empty base.
 */
export function gitRefResolves(platformDir: string, ref: string): boolean {
  if (!isSafeRef(ref)) return false;
  const proc = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: platformDir,
  });
  return proc.exitCode === 0;
}

/**
 * A null is ambiguous (absent path vs unreadable ref or repo): callers that
 * need the distinction gate on `gitRefResolves` first.
 */
export function gitShow(platformDir: string, ref: string, relPath: string): string | null {
  if (!isSafeRef(ref)) return null;
  const full = `${gitRepoPrefix(platformDir)}${relPath}`;
  const proc = Bun.spawnSync(["git", "show", `${ref}:${full}`], { cwd: platformDir });
  if (proc.exitCode !== 0) return null;
  return proc.stdout.toString();
}

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

export interface DiffEntry {
  status: string;
  path: string;
}

/**
 * `--no-renames` splits a rename into a `D` plus an `A`, so a moved
 * requirement or tag is never hidden behind an `R` (SPEC_FILE_DELETED and
 * IMPL_LOST depend on seeing the `D`). `--relative` limits the diff to the
 * platform subtree and makes each path platform-relative. Untracked files are
 * deliberately absent: a new file cannot delete a prior requirement.
 */
export function gitDiffNameStatus(platformDir: string, ref: string): DiffEntry[] {
  if (!isSafeRef(ref)) return [];
  const proc = Bun.spawnSync(
    ["git", "diff", "--name-status", "--no-renames", "--relative", ref, "--"],
    {
      cwd: platformDir,
    },
  );
  if (proc.exitCode !== 0) return [];
  const rows: DiffEntry[] = [];
  for (const line of proc.stdout.toString().split("\n")) {
    if (line.length === 0) continue;
    const parts = line.split("\t");
    const status = (parts[0] ?? "").trim().toUpperCase();
    const path = (parts[parts.length - 1] ?? "").trim();
    if (status.length === 0 || path.length === 0) continue;
    rows.push({ status, path });
  }
  return rows;
}

// @spec REQ-047
export function newestReleaseTag(platformDir: string): string | null {
  const proc = Bun.spawnSync(
    ["git", "tag", "--list", "v*", "--merged", "HEAD", "--sort=-v:refname"],
    { cwd: platformDir },
  );
  if (proc.exitCode !== 0) return null;
  const tag = proc.stdout.toString().split("\n")[0]?.trim() ?? "";
  return tag !== "" && isSafeRef(tag) ? tag : null;
}
