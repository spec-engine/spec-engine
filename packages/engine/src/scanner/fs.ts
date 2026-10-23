// A manual `node:fs` recursion rather than a `**` glob: an ignored directory is
// pruned before descending, so `node_modules/` (often 100k+ files) is never
// enumerated at all.
//
// `readdir` order is not guaranteed, so every walk sorts before returning:
// tag insertion order fixes the tags.id AUTOINCREMENT sequence.
//
// Symlinks are not followed: a symlink Dirent is neither `isDirectory()` nor
// `isFile()`, so it matches no branch. `.gitignore` is deliberately not read.

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Ignore tokens, matched at a SEGMENT boundary (see `isPathIgnored`). The
 *  trailing slash on every entry is load-bearing: it anchors the match to a
 *  directory-segment end so `dist/` never matches a file like `dist.ts` nor a
 *  sibling dir like `mydist/`. `fixtures/` holds planted test trees: the mess
 *  in them is the test, never a live coverage claim. */
export const IGNORE_SUBSTR = Object.freeze([
  "node_modules/",
  ".git/",
  ".spec-engine/",
  ".factory/",
  ".next/",
  ".turbo/",
  ".cache/",
  "dist/",
  "build/",
  "coverage/",
  "fixtures/",
]) as readonly string[];

/**
 * True when `path` is ignored. A built-in token matches at a segment boundary
 * at any depth (`("/" + path)` lets it match the first segment too), so
 * `dist/` ignores `src/dist/…` but not `src/mydist/…`. An `extra` token
 * matches only as a repo-relative prefix, a bare `generated` read as
 * `generated/`, so it never hides a same-named directory deeper in the tree.
 * @spec INDX-027
 */
export function isPathIgnored(path: string, extra: readonly string[] = []): boolean {
  const anchored = `/${path}`;
  return (
    IGNORE_SUBSTR.some((t) => anchored.includes(`/${t}`)) ||
    extra.some((t) => path.startsWith(t.endsWith("/") ? t : `${t}/`))
  );
}

/** `.github/` is the one dot entry opened: a workflow is often a promise's
 *  only implementation.
 *  @spec INDX-021 */
function isHiddenEntry(name: string): boolean {
  return name.startsWith(".") && name !== ".github";
}

/** True when the walk never reaches `rel`: one of its segments is a hidden entry. */
export function isHiddenPath(rel: string): boolean {
  return rel.split("/").some(isHiddenEntry);
}

/** An unreadable directory is skipped rather than thrown: a walk must never
 *  crash the indexer. */
async function walkInto(
  rootDir: string,
  relDir: string,
  keep: (relPath: string) => boolean,
  extraIgnore: readonly string[],
  out: string[],
): Promise<void> {
  const absDir = relDir ? join(rootDir, relDir) : rootDir;
  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (isHiddenEntry(ent.name)) continue;
    const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (!isPathIgnored(`${rel}/`, extraIgnore)) {
        await walkInto(rootDir, rel, keep, extraIgnore, out);
      }
    } else if (ent.isFile() && keep(rel)) {
      out.push(rel);
    }
  }
}

async function walkFiles(
  rootDir: string,
  keep: (relPath: string) => boolean,
  extraIgnore: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  await walkInto(rootDir, "", keep, extraIgnore, out);
  out.sort();
  return out;
}

/** Default code-file extensions. The tag regex is comment-leader agnostic, so a
 *  language joins by its extension alone; its test-file convention joins
 *  `TEST_MATCH` in tags.ts. A Dockerfile has no extension: `isDockerfile`.
 *  @spec INDX-020 */
export const DEFAULT_EXTS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "sh",
  "lua",
  "luau",
  "go",
  "rs",
  "tf",
  "toml",
  "sql",
  "css",
  "yml",
  "yaml",
  "astro",
] as const;

/** `Dockerfile` or `Dockerfile.<suffix>`, judged on the basename.
 *  @spec INDX-020 */
function isDockerfile(name: string): boolean {
  return name === "Dockerfile" || (name.startsWith("Dockerfile.") && name.length > 11);
}

/** Whether the file at `rel` is one the tag scanner reads; `guard` applies the same test at a base ref.
 *  @spec INDX-020 */
export function isTagSource(rel: string, exts: readonly string[] = DEFAULT_EXTS): boolean {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return isDockerfile(name) || (dot > 0 && exts.includes(name.slice(dot + 1)));
}

export async function findDomainJsonFiles(canonicalDir: string): Promise<string[]> {
  return walkFiles(canonicalDir, (rel) => rel === "SPEC.json" || rel.endsWith("/SPEC.json"), []);
}

/** `extraIgnore` holds repo-relative prefixes for this call only, e.g. the
 *  in-repo `spec-engine/` dir so nothing beside the canonical specs is counted
 *  as member code. */
export async function findCodeFiles(
  repoDir: string,
  exts: readonly string[] = DEFAULT_EXTS,
  extraIgnore: readonly string[] = [],
): Promise<string[]> {
  return walkFiles(repoDir, (rel) => isTagSource(rel, exts), extraIgnore);
}

/** Whether the file at `rel` is one the doc scanner reads. A SPEC.md anywhere is a spec source, never documentation. */
export function isDocSource(rel: string): boolean {
  return rel.endsWith(".md") && rel !== "SPEC.md" && !rel.endsWith("/SPEC.md");
}

export async function findDocFiles(
  repoDir: string,
  extraIgnore: readonly string[] = [],
): Promise<string[]> {
  return walkFiles(repoDir, isDocSource, extraIgnore);
}
