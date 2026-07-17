// packages/engine/src/indexer/discover.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INIT-006
//
// INDX-01: platform discovery — enumerates the canonical `spec-engine/` dir
// plus every sibling member that carries a `spec-engine.member.json`.
// INDX-02: Zod validation — every member's pin string goes through
// `SpecConfigSchema`.
// RED-85: the platform version is DERIVED (max domain version, computed by
// `derivePlatformVersion` below); the authored `spec-engine.platform.json`
// manifest is retired and a stray one is ignored with a warning.
//
// Source pattern: 02-RESEARCH § Platform & repo discovery (lines 908-973).
// Pitfall 5 (Zod error surfacing): a malformed spec-engine.member.json must throw
// a clear, location-tagged error rather than crashing deep inside Zod.
//
// Determinism: sibling directories are enumerated via Bun.Glob (iteration
// order not guaranteed — Bun #10112) and sorted lexicographically before
// returning. Downstream (pipeline.ts) re-sorts at the row layer; the sort
// here keeps cold-rebuild equivalence stable at the discovery seam too.
//
// Engine-tier purity: this module reads JSON via Bun.file (not node:fs
// readFileSync — CLAUDE.md mandates Bun-native I/O). The node:fs imports
// are used ONLY for synchronous directory existence checks during
// enumeration; no file content is loaded through node:fs.
//
// D-08: NEVER import bun:sqlite here.

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  NotASpecPlatformError,
  type Repo,
  type SkippedRepo,
  SpecConfigSchema,
} from "@spec-engine/shared";
import { isExistingDir, PLATFORM_MANIFEST_FILENAME } from "../constants";
import { parseDomainJsonFile } from "../parser/domainJson";
import { findDomainJsonFiles } from "../scanner/fs";

/**
 * Friendly, actionable message for the not-a-Spec Engine-platform case. Shared by
 * the `map` / `index` / `check` command boundaries so the prose lives in one
 * place. Dependency-free (no bun:sqlite, no I/O) — pure string assembly.
 */
export function formatNotASpecPlatform(platformDir: string): string {
  return [
    `${platformDir} is not a Spec Engine platform yet (no spec-engine/ directory).`,
    "A platform directory must contain a canonical spec-engine/ folder holding your SPEC.md requirements.",
    "To get your first spec completed:",
    "  spec domain new <KEY>   scaffold spec-engine/<KEY>/SPEC.md (e.g. spec domain new BILLING)",
    "  spec req <KEY>          author your first requirement interactively",
    "To see a worked example, run:  spec map fixtures/platform-fixture",
    'For the full walkthrough, see the "Getting started" section of the README.',
  ].join("\n");
}

/**
 * Friendly, actionable message for the indexed-but-empty case: the platform
 * directory IS a Spec Engine platform (spec-engine/ exists) but the derived index
 * holds zero requirements. RED-11: read commands (`map` / `query` / `resolve`
 * / `propagation`) emit this on stderr instead of silent blank output, still
 * exiting 0 — empty data is not an error, but a brand-new platform deserves
 * a pointer toward its first completed spec. Pure string assembly, no I/O.
 */
export function formatNoRequirementsIndexed(platformDir: string): string {
  return [
    `No requirements indexed at ${platformDir}.`,
    "To get your first spec completed:",
    "  spec domain new <KEY>   scaffold spec-engine/<KEY>/SPEC.md (e.g. spec domain new BILLING)",
    "  spec req <KEY>          author your first requirement interactively",
    "Then re-run `spec index` followed by this command.",
    "To see a worked example: spec map fixtures/platform-fixture",
  ].join("\n");
}

/**
 * Lightweight pre-flight guard: throws `NotASpecPlatformError` when
 * `<platformDir>/spec-engine` is absent (or not a directory), WITHOUT
 * touching the derived index or any member enumeration.
 *
 * Command boundaries (`map` / `index` / `check`) call this as their very
 * first step — BEFORE `mkdirSync(.spec-engine)` / `openStorage` — so pointing any
 * command at a non-platform directory throws → friendly message → exit 2
 * and leaves NO `.spec-engine/` artifact behind. This upholds the CLAUDE.md
 * invariant that the derived DB owns nothing: a failed build must leave no
 * artifact, and the not-a-platform case stays idempotent across runs
 * (no stale empty index can poison the second invocation).
 *
 * `discoverRepos` keeps its own identical existsSync/isDirectory check as
 * defense-in-depth for programmatic callers that bypass the command layer.
 *
 * D-08: dependency-free — no bun:sqlite, no derived-index access.
 */
export function assertSpecPlatform(platformDir: string): void {
  const absPlatform = resolve(platformDir);
  const canonicalPath = join(absPlatform, "spec-engine");
  if (!isExistingDir(canonicalPath)) {
    throw new NotASpecPlatformError(absPlatform);
  }
}

/**
 * Repo-root signal (RUNG1-02): a child directory of the platform root counts
 * as a sibling repo ONLY if it looks like a repo root — i.e. it carries a
 * `.git` entry (a directory for a normal clone, OR a file for a submodule /
 * worktree gitlink) or a `package.json`. This is a deliberate heuristic for
 * the PoC: a real unwired member repo always has `.git`/`package.json`, so
 * it still trips `NO_SPEC_CONFIG` (v1.1 intent preserved); a plain folder
 * that is part of the platform's OWN tree (`src/`, `test/`, `lib/`, `docs/`,
 * …) has neither marker, so it is NOT a sibling and must not enumerate as a
 * config-less "skipped" repo. Without this signal a single repo whose code
 * lives in `src/`/`test/` subdirs would enumerate those subdirs as skipped
 * siblings → `NO_SPEC_CONFIG src` / `NO_SPEC_CONFIG test`, AND would suppress
 * the self-member (because skipped.length > 0), leaving its `@spec` tags
 * unscanned (tags:0). Keying the marker on the CHILD (not on platformDir
 * itself) is what lets a self-contained repo self-consume.
 *
 * Marker set is `.git` (dir or file) + `package.json` — intentionally small
 * for the PoC; broaden only if a real member shape proves to need it.
 */
function looksLikeRepoRoot(dirPath: string): boolean {
  // `.git` may be a directory (ordinary clone) or a file (submodule / linked
  // worktree gitlink). existsSync is true for both, which is exactly what we
  // want — either form marks `dirPath` as the root of its own repository.
  if (existsSync(join(dirPath, ".git"))) return true;
  if (existsSync(join(dirPath, "package.json"))) return true;
  return false;
}

/**
 * Read and validate a `spec-engine.member.json` at `configPath`.
 * Returns the parsed config; throws a clear, location-tagged error on
 * validation failure (Pitfall 5).
 *
 * WR-04: wraps the read in a try/catch so an ENOENT (file vanished
 * between the caller's existsSync check and this read — non-malicious
 * TOCTOU from a concurrent `git checkout`, fixture cleanup, etc.) is
 * surfaced as a clear "could not be read" message rather than a bare
 * Bun.file error that matches neither of the two clean error paths
 * this function advertises.
 */
export async function readRepoConfig(
  configPath: string,
): Promise<{ specs: string; ignore?: string[]; members?: string }> {
  let text: string;
  try {
    text = await Bun.file(configPath).text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`spec-engine.member.json at ${configPath} could not be read: ${msg}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`spec-engine.member.json at ${configPath} failed to parse as JSON: ${msg}`);
  }
  try {
    return SpecConfigSchema.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`spec-engine.member.json at ${configPath} failed validation: ${msg}`);
  }
}

/**
 * Extract the integer pin from a `spec-engine@N` string. Returns the
 * parsed integer; throws if the input does not match the regex. (The Zod
 * schema already guarantees the shape, but parsing the integer separately
 * keeps the indexer's intent explicit.)
 */
function extractPin(specs: string): number {
  const m = specs.match(/^spec-engine@(\d+)$/);
  if (!m) {
    throw new Error(`expected 'spec-engine@N', got ${JSON.stringify(specs)}`);
  }
  return Number.parseInt(m[1] as string, 10);
}

/**
 * Derive the PLATFORM version: the maximum of the domains' DAG-derived
 * versions (SCHM-007) across `spec-engine/<KEY>/SPEC.json`, default `1` when
 * the platform has no parseable domains. Every file goes through the ONE
 * reader (`parseDomainJsonFile`) so this number can never disagree with the
 * `spec_version` the index derives; a file the reader rejects contributes
 * nothing here — its loud INVALID_DOMAIN_FILE reject belongs to the parse
 * stage, not discovery.
 *
 * No authored counter exists at the platform level: an authored scalar beside
 * derived domain versions is the same two-sources-of-truth smell SCHM-008
 * kills one level down. The retired `spec-engine.platform.json` manifest is
 * ignored; command paths surface `warnIfRetiredManifest` beside this call.
 */
export async function derivePlatformVersion(platformDir: string): Promise<number> {
  // @spec SCHM-009
  const canonicalPath = join(resolve(platformDir), "spec-engine");
  const jsonPaths = await findDomainJsonFiles(canonicalPath);
  let version = 1;
  for (const rel of jsonPaths) {
    let text: string;
    try {
      text = await Bun.file(join(canonicalPath, rel)).text();
    } catch {
      continue; // unreadable → contributes nothing; the parse stage owns the loud reject
    }
    const result = parseDomainJsonFile({
      text,
      sourceFile: `spec-engine/${rel}`,
      fallbackKey: basename(dirname(rel)),
    });
    if (result.ok) version = Math.max(version, result.spec.spec_version);
  }
  return version;
}

/**
 * RED-85: `spec-engine.platform.json` is retired — the platform version is
 * derived, never authored. A stray manifest is IGNORED (never parsed, never an
 * error); this warning tells the operator why editing it does nothing and how
 * to clean up. Emitted on stderr by the discovery and init paths.
 */
export function warnIfRetiredManifest(platformDir: string, derivedVersion: number): void {
  const manifestPath = join(resolve(platformDir), "spec-engine", PLATFORM_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return;
  console.error(
    `spec: warning: ${manifestPath} is retired and ignored — the platform version is ` +
      `derived from the domain SPEC.json files (currently ${derivedVersion}). Delete the file.`,
  );
}

/**
 * 2.7: expand a monorepo member into its workspace sub-members. Called when a
 * member's `spec-engine.member.json` carries a `members` glob (relative to the
 * config's own directory). Each matching SUBDIRECTORY becomes its own Repo —
 * so `packages/*` gives engine/shared/tracker/webapp their OWN coverage
 * columns instead of collapsing into a single `packages` blob.
 *
 * Naming: a sub-member's `name` is its platform-relative path
 * (`${parentName}/${rel}`, e.g. `packages/engine`), which is exactly what the
 * tag scanner prepends to produce honest platform-relative tag paths
 * (`packages/engine/src/…`) — so `spec resolve packages/engine/src/foo.ts`
 * resolves naturally.
 *
 * Per-package pin: a sub-member inherits `parentPin` UNLESS it carries its own
 * nested `spec-engine.member.json`, whose pin (and `ignore`) then win — the
 * mechanism that lets one package sit on `spec-engine@2` while another lags on
 * `@1`. Glob matches that are files (the `spec-engine.member.json` itself) or a
 * `spec-engine` directory are dropped. Matches are sorted for determinism.
 */
async function expandWorkspaceMembers(
  repoPath: string,
  parentName: string,
  membersGlob: string,
  parentPin: number,
): Promise<Repo[]> {
  const matches: string[] = [];
  const glob = new Bun.Glob(membersGlob);
  for await (const m of glob.scan({ cwd: repoPath, onlyFiles: false, dot: false })) {
    matches.push(m);
  }
  matches.sort();

  const subs: Repo[] = [];
  for (const rel of matches) {
    const subPath = join(repoPath, rel);
    if (!isExistingDir(subPath)) continue; // a glob can match files, not just dirs
    if (basename(subPath) === "spec-engine") continue; // never shadow the canonical row

    const subConfigPath = join(subPath, "spec-engine.member.json");
    let pin = parentPin;
    let ignore: string[] | undefined;
    if (existsSync(subConfigPath)) {
      const subCfg = await readRepoConfig(subConfigPath);
      pin = extractPin(subCfg.specs);
      ignore = subCfg.ignore && subCfg.ignore.length > 0 ? subCfg.ignore : undefined;
    }
    subs.push({
      name: `${parentName}/${rel}`,
      path: subPath,
      pinned_spec_version: pin,
      ...(ignore ? { ignore } : {}),
    });
  }
  return subs;
}

/**
 * Tagged result of classifying one top-level sibling entry:
 *   - `member`:   carries a `spec-engine.member.json` → a configured member Repo
 *   - `expanded`: carries a config with a `members` glob → one Repo per
 *                 workspace sub-member (2.7)
 *   - `skipped`:  a repo root (.git/package.json) without a config → NO_SPEC_CONFIG
 *   - `ignored`:  not a sibling (the canonical dir, a loose file, or a plain
 *                 folder in platformDir's own tree) → dropped from enumeration
 */
type SiblingClassification =
  | { kind: "member"; repo: Repo }
  | { kind: "expanded"; repos: Repo[] }
  | { kind: "skipped"; skipped: SkippedRepo }
  | { kind: "ignored" };

/**
 * Classify a single enumerated sibling `name` (relative to `absPlatform`) into
 * one of the three sibling buckets. Owns the isExistingDir / configPath /
 * looksLikeRepoRoot checks and the per-member pin + T7 ignore assembly.
 */
async function classifySibling(name: string, absPlatform: string): Promise<SiblingClassification> {
  if (name === "spec-engine") return { kind: "ignored" };
  const repoPath = join(absPlatform, name);
  // Skip anything that isn't a directory (loose files at platform root).
  if (!isExistingDir(repoPath)) return { kind: "ignored" };

  const configPath = join(repoPath, "spec-engine.member.json");
  // Three-bucket sibling classification (RUNG1-02 repo-root signal):
  //   1. has spec-engine.member.json                       → configured MEMBER
  //   2. no config BUT looksLikeRepoRoot (.git/pkg)  → SKIPPED sibling
  //      (drives NO_SPEC_CONFIG — a real unwired member repo)
  //   3. no config AND no repo-root marker           → NOT a sibling
  //      (a plain folder belonging to platformDir's own tree: src/, test/,
  //      lib/, docs/ …). Ignored from sibling enumeration entirely.
  //
  // Bucket 3 is the fix for the realistic single-repo shape: a lone repo
  // with code in `src/`/`test/` subdirs must NOT enumerate those subdirs as
  // config-less siblings, or it would (a) emit spurious `NO_SPEC_CONFIG
  // src`/`NO_SPEC_CONFIG test`, and (b) suppress the self-member below
  // (skipped.length would be > 0), leaving its `@spec` tags unscanned.
  //
  // The caller sorts `entries` lexicographically before folding, so the
  // resulting `skipped[]` inherits lex-by-name ordering (Pitfall 3: Bun.Glob
  // iteration is non-deterministic; the upstream sort is the determinism
  // source). Phase 8 (DISC-03) iterates `skipped[]` and emits one
  // `NO_SPEC_CONFIG` warning-severity ParseDiagnostic per entry.
  if (!existsSync(configPath)) {
    if (looksLikeRepoRoot(repoPath)) {
      // Bucket 2: a real repo root without a Spec Engine config → skipped sibling.
      return { kind: "skipped", skipped: { name, path: repoPath } };
    }
    // Bucket 3: plain folder, not a repo → silently ignored (it belongs to
    // platformDir's own tree and is scanned as part of the self-member).
    return { kind: "ignored" };
  }

  const cfg = await readRepoConfig(configPath);
  const parentPin = extractPin(cfg.specs);

  // 2.7: a `members` glob expands this member into its workspace sub-members
  // instead of registering the config's directory as a single member.
  if (cfg.members) {
    return {
      kind: "expanded",
      repos: await expandWorkspaceMembers(repoPath, name, cfg.members, parentPin),
    };
  }

  return {
    kind: "member",
    repo: {
      name,
      path: repoPath,
      pinned_spec_version: parentPin,
      // T7: per-repo scan-ignore hint — only attached when authored, so the
      // returned shape stays byte-identical for ignore-less configs.
      ...(cfg.ignore && cfg.ignore.length > 0 ? { ignore: cfg.ignore } : {}),
    },
  };
}

/**
 * Walks `platformDir` and returns:
 *   - canonical: the `spec-engine/` Repo row (mandatory; throws if absent)
 *   - platformVersion: the DERIVED platform version (max domain version via
 *     `derivePlatformVersion`; default `1` on a domain-less platform)
 *   - members: every sibling directory that carries a `spec-engine.member.json`,
 *     with the parsed pin integer, sorted lexicographically by name.
 *
 * Siblings without a `spec-engine.member.json` are skipped silently
 * (RESEARCH lines 947-955).
 */
export async function discoverRepos(platformDir: string): Promise<{
  canonical: Repo;
  platformVersion: number;
  members: Repo[];
  skipped: SkippedRepo[];
}> {
  const absPlatform = resolve(platformDir);
  const canonicalPath = join(absPlatform, "spec-engine");

  if (!isExistingDir(canonicalPath)) {
    throw new NotASpecPlatformError(absPlatform);
  }

  const platformVersion = await derivePlatformVersion(absPlatform);
  warnIfRetiredManifest(absPlatform, platformVersion);

  // @spec INIT-014
  const canonical: Repo = {
    name: "spec-engine",
    path: canonicalPath,
    pinned_spec_version: platformVersion,
  };

  // Enumerate top-level entries deterministically. Bun.Glob does not
  // guarantee iteration order; sort lexicographically before iterating
  // so member discovery is stable across runs.
  const entries: string[] = [];
  const glob = new Bun.Glob("*");
  for await (const m of glob.scan({ cwd: absPlatform, onlyFiles: false, dot: false })) {
    entries.push(m);
  }
  entries.sort();

  // Fold the three-bucket classifier over each sorted entry: configured
  // members and skipped repo-roots accumulate; ignored entries drop out.
  const members: Repo[] = [];
  const skipped: SkippedRepo[] = [];
  for (const name of entries) {
    const result = await classifySibling(name, absPlatform);
    if (result.kind === "member") members.push(result.repo);
    else if (result.kind === "expanded") members.push(...result.repos);
    else if (result.kind === "skipped") skipped.push(result.skipped);
  }
  // Determinism at the discovery seam: workspace expansion inserts several
  // members at one entry, so re-sort by name (pipeline re-sorts too, but a
  // stable order here keeps this seam's output diff-stable).
  members.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // RUNG1-01 (single-repo / "rung 1") self-member registration.
  //
  // Trigger (D-01): `spec-engine/` is present AND there are ZERO sibling
  // members AND ZERO skipped siblings — i.e. a truly-lone repo that keeps
  // its specs inline and tags its own code. In that shape we register the
  // platform directory ITSELF as the lone member so its `@spec` tags show
  // up as one coverage column (labeled by the platformDir basename) instead
  // of the matrix being empty.
  //
  // Why both `members` AND `skipped` must be empty: if ANY sibling member
  // exists, the platform already has a member to scan (multi-repo mode —
  // unchanged). If a skipped sibling exists (a dir without spec-engine.member.json),
  // that sibling drives NO_SPEC_CONFIG and the user is mid-onboarding, not
  // running a lone repo — so self-member mode does NOT fire. Loose FILES at
  // the platform root never populate either array (the isDirectory() filter
  // in classifySibling drops them), so a `spec-engine/` + loose-files-only dir
  // correctly IS a self-member. This is the regression guard for multi-repo
  // output: whenever ≥1 sibling member or ≥1 skipped sibling exists, the push
  // below never runs and the returned shape is byte-identical to today's.
  //
  // pin = platformVersion (D-03, revised by RED-85): the self-member is
  // implicitly pinned to the DERIVED platform version (max domain version), so
  // for requirement domains the drift VIEW predicate
  // `changed_at_version > pinned_spec_version` is structurally impossible —
  // a requirement's changed_at_version never exceeds its domain's derived
  // version, which never exceeds the max. (Under the retired AUTHORED manifest
  // this claim had silently become false: domains derive past a counter nothing
  // bumps.) It needs no spec-engine.member.json.
  //
  // Out of scope (documented, not handled): a platformDir literally named
  // "spec-engine" would collide with the canonical row's `name: "spec-engine"`.
  // The canonical row already owns that name; we proceed with the basename and
  // do NOT add disambiguator machinery — a non-goal for the PoC.
  if (members.length === 0 && skipped.length === 0) {
    members.push({
      name: basename(absPlatform),
      path: absPlatform,
      pinned_spec_version: platformVersion,
      selfMember: true,
    });
  }

  return { canonical, platformVersion, members, skipped };
}
