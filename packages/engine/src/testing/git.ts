// packages/engine/src/testing/git.ts
//
// Drive git in a test's own temporary tree, with a fixed identity and signing
// off so the user's global config cannot change the outcome.

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "spec Test",
  GIT_AUTHOR_EMAIL: "test@spec.local",
  GIT_COMMITTER_NAME: "spec Test",
  GIT_COMMITTER_EMAIL: "test@spec.local",
};

export function git(cwd: string, ...args: string[]): void {
  if (!cwd) throw new Error("git helper needs a cwd; refusing to run in the process cwd");
  const proc = Bun.spawnSync(
    ["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
    { cwd, env: GIT_ENV },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

/** Make `dir` a repository whose single commit carries `tag`. */
export function commitAndTag(dir: string, tag: string): void {
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", tag);
  git(dir, "tag", tag);
}
