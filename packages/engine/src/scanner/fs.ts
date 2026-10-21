// packages/engine/src/scanner/fs.ts
//
// PARS-03 + PARS-04: filesystem walker for the indexer.
//
// 2.5 (walk-level pruning): the walk is a manual `node:fs` recursion that
// SKIPS an ignored directory before descending into it, instead of globbing
// the WHOLE tree with `Bun.Glob("**/…")` and filtering the results afterward.
// On a real member repo the old walk-then-filter enumerated every file under
// `node_modules/` (often 100k+) only to throw them away; pruning at the
// directory level never opens those subtrees at all. A pruning walk is faster
// than a full `**` glob here, so this supersedes the earlier Bun.Glob mandate
// for THIS module (the mandate's motivation was speed). No file content is
// read — this is a directory walk only.
//
// Determinism rule: `readdir` order is not guaranteed,
// so every helper collects into an array and `.sort()`s before returning, so
// downstream side effects (tag insertion order → tags.id AUTOINCREMENT
// sequence) are stable across runs and across machines.
//
// Symlinks are NOT followed: `Dirent.isDirectory()`/`isFile()` both report
// false for a symlink (it is `isSymbolicLink()`), so it matches neither the
// descend branch nor the keep branch and is skipped — the same non-follow
// behavior the previous `Bun.Glob.scan` default had.
//
// Ignore-list contract: a path is ignored when any built-in token appears at a
// segment boundary at any depth, or when it starts with a caller-supplied
// `extra` token. Built-in tokens:
//   - node_modules/
//   - .git/
//   - .spec-engine/  (derived index dir — keep tag scans away from generated artifacts)
//   - .factory/  (planning docs — no .ts should ever land here, defensive)
//   - .next/ .turbo/ .cache/  (build/tool caches common in members)
//   - dist/ build/ coverage/
//   - fixtures/  (planted test-fixture trees — the mess in them is the test,
//                 never a live coverage claim)
// A real `.gitignore` integration is a v2 concern (CLAUDE.md "What NOT to Use").

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Ignore tokens, matched at a SEGMENT boundary (see `isPathIgnored`). The
 *  trailing slash on every entry is load-bearing: it anchors the match to a
 *  directory-segment end so `dist/` never matches a file like `dist.ts` nor a
 *  sibling dir like `mydist/`. */
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
 * @spec INDX-018
 */
export function isPathIgnored(path: string, extra: readonly string[] = []): boolean {
  const anchored = `/${path}`;
  return (
    IGNORE_SUBSTR.some((t) => anchored.includes(`/${t}`)) ||
    extra.some((t) => path.startsWith(t.endsWith("/") ? t : `${t}/`))
  );
}

/**
 * Recurse one directory (module-level, not a closure, to keep the cognitive
 * complexity low): read `<rootDir>/<relDir>`, prune ignored subtrees before
 * descending, and push kept files into `out`. Dot-prefixed entries are skipped
 * (`Bun.Glob.scan({ dot: false })` parity). An unreadable directory is skipped
 * rather than throwing — a walk must never crash the indexer. Symlinks report
 * `isSymbolicLink()` (neither file nor directory) so they are not followed.
 */
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
    if (ent.name.startsWith(".")) continue; // dot:false semantics
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

/**
 * 2.5: walk `rootDir`, pruning ignored directories BEFORE descending, and
 * return the repo-relative paths of files for which `keep` returns true,
 * lexicographically sorted. `extraIgnore` applies on top of the built-in tokens
 * for THIS walk only.
 */
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
 *  @spec INDX-019 */
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
] as const;

/** `Dockerfile` or `Dockerfile.<suffix>`, judged on the basename.
 *  @spec INDX-019 */
function isDockerfile(name: string): boolean {
  return name === "Dockerfile" || (name.startsWith("Dockerfile.") && name.length > 11);
}

/** Whether the file at `rel` is one the tag scanner reads; `guard` applies the same test at a base ref.
 *  @spec INDX-019 */
export function isTagSource(rel: string, exts: readonly string[] = DEFAULT_EXTS): boolean {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return isDockerfile(name) || (dot > 0 && exts.includes(name.slice(dot + 1)));
}

/**
 * STOR-02 (17-02): walk `canonicalDir` for files named exactly `SPEC.json`.
 * Returns the canonical-relative paths, lexicographically sorted. Post-cutover
 * this is the SOLE spec-file glob — the Markdown spec-file
 * walker is deleted, so `spec index` discovers JSON domains only.
 *
 * Symlinks are not followed (Bun.Glob.scan default behavior).
 */
export async function findDomainJsonFiles(canonicalDir: string): Promise<string[]> {
  return walkFiles(canonicalDir, (rel) => rel === "SPEC.json" || rel.endsWith("/SPEC.json"), []);
}

/**
 * Walk `repoDir` for files matching `**\/*.{ts,tsx,js,jsx,mjs}` (or the
 * caller-supplied `exts` list). Returns repo-relative paths, lexicographically
 * sorted, with ignored substrings filtered out.
 *
 * `extraIgnore` applies on top of `IGNORE_SUBSTR` for THIS call only, matched
 * as repo-relative prefixes. It lets the self-member scan (RUNG1-01)
 * exclude the in-repo `spec-engine/` subfolder so the canonical SPEC.md dir
 * (and any `.ts` beside it) is never double-counted as member code. The
 * default `[]` keeps every existing two-arg / three-arg-with-exts caller
 * byte-identical.
 *
 * Symlinks are not followed (Bun.Glob.scan default behavior).
 */
export async function findCodeFiles(
  repoDir: string,
  exts: readonly string[] = DEFAULT_EXTS,
  extraIgnore: readonly string[] = [],
): Promise<string[]> {
  return walkFiles(repoDir, (rel) => isTagSource(rel, exts), extraIgnore);
}

/**
 * RED-15: walk `repoDir` for documentation markdown (`**\/*.md`). Same
 * ignore-list + determinism contract as `findCodeFiles`. Files named
 * exactly `SPEC.md` are excluded — those are spec sources owned by the
 * canonical dir (and the self-member scan already excludes
 * `spec-engine/` via `extraIgnore`); a stray SPEC.md elsewhere in a
 * member is still not documentation.
 *
 * Symlinks are not followed (Bun.Glob.scan default behavior).
 */
export async function findDocFiles(
  repoDir: string,
  extraIgnore: readonly string[] = [],
): Promise<string[]> {
  return walkFiles(
    repoDir,
    // Documentation markdown, EXCLUDING SPEC.md (spec sources owned by the
    // canonical dir; a stray SPEC.md elsewhere is still not documentation).
    (rel) => rel.endsWith(".md") && rel !== "SPEC.md" && !rel.endsWith("/SPEC.md"),
    extraIgnore,
  );
}
