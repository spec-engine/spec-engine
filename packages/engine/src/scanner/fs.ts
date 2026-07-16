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
// Determinism rule (PARS-04 / Pitfall 1): `readdir` order is not guaranteed,
// so every helper collects into an array and `.sort()`s before returning, so
// downstream side effects (tag insertion order → tags.id AUTOINCREMENT
// sequence) are stable across runs and across machines.
//
// Symlinks are NOT followed: `Dirent.isDirectory()`/`isFile()` both report
// false for a symlink (it is `isSymbolicLink()`), so it matches neither the
// descend branch nor the keep branch and is skipped — the same non-follow
// behavior the previous `Bun.Glob.scan` default had.
//
// Ignore-list contract: a path is ignored when any ignore token appears at a
// SEGMENT boundary (2.5 anchor fix). The tokens carry a trailing slash and the
// match is `("/" + path).includes("/" + token)`, so `dist/` ignores
// `src/dist/…` but NOT `src/mydist/…` — the previous bare-substring match
// wrongly swallowed the latter. Tokens:
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
 * True when `path` is ignored by any built-in or `extra` token, matched at a
 * SEGMENT boundary (2.5). `("/" + path)` prepends a leading separator so a
 * token like `dist/` matches a path that STARTS with `dist/` as well as one
 * that contains `/dist/`, while `src/mydist/foo` (where `dist/` is only a
 * substring, not a segment) is correctly NOT ignored. `extra` tokens are
 * normalized to a trailing slash so a bare `generated` and `generated/` behave
 * identically.
 */
export function isPathIgnored(path: string, extra: readonly string[] = []): boolean {
  const anchored = `/${path}`;
  const tokens = extra.length === 0 ? IGNORE_SUBSTR : [...IGNORE_SUBSTR, ...extra];
  return tokens.some((t) => anchored.includes(`/${t.endsWith("/") ? t : `${t}/`}`));
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

/** Default code-file extensions (ported verbatim from `spec.mjs:10`).
 *  Exported so the pipeline can pass it explicitly when it also needs to
 *  supply `extraIgnore` (the self-member scan excludes `spec-engine/`). */
export const DEFAULT_EXTS = ["ts", "tsx", "js", "jsx", "mjs"] as const;

/**
 * STOR-02 (17-02): walk `canonicalDir` for files named exactly `SPEC.json`.
 * Returns the canonical-relative paths, lexicographically sorted. Post-cutover
 * (Phase 18, D2) this is the SOLE spec-file glob — the Markdown spec-file
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
 * `extraIgnore` is appended to `IGNORE_SUBSTR` for THIS call only, using the
 * same substring-match semantics. It lets the self-member scan (RUNG1-01)
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
  const extSet = new Set(exts);
  return walkFiles(
    repoDir,
    (rel) => {
      const dot = rel.lastIndexOf(".");
      return dot > 0 && extSet.has(rel.slice(dot + 1));
    },
    extraIgnore,
  );
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
