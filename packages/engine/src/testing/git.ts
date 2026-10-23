import { gitEnv } from "../base/gitBase";

// GIT_CONFIG_* is dropped too: a `git -c` from the parent arrives as
// GIT_CONFIG_PARAMETERS, and the global and system files are pinned off, so no
// outside config reaches a test repository.
export function gitTestEnv(): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(Object.entries(gitEnv()).filter(([k]) => !k.startsWith("GIT_CONFIG"))),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "spec Test",
    GIT_AUTHOR_EMAIL: "test@spec.local",
    GIT_COMMITTER_NAME: "spec Test",
    GIT_COMMITTER_EMAIL: "test@spec.local",
  };
}

export function git(cwd: string, ...args: string[]): void {
  if (!cwd) throw new Error("git helper needs a cwd; refusing to run in the process cwd");
  const proc = Bun.spawnSync(
    ["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
    { cwd, env: gitTestEnv() },
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
