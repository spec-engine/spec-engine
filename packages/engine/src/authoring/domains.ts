// @spec DOMAIN-011
// @spec DOMAIN-016
// @spec REQ-026
//
// Domains are enumerated from the filesystem, never the derived index: the
// index owns nothing, and this module stays free of bun:sqlite.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDomainText, type SpecDomain, type SpecRequirement } from "@spec-engine/shared";
import { gitEnv } from "../base/gitBase";
import { specPaths } from "../constants";

export { KEY_RE } from "@spec-engine/shared";

/**
 * Spaces are stripped, never converted to dashes: `-` separates key from seq
 * in a requirement id (`<KEY>-<NNN>`), so a dashed key (`USER-AUTH`) would
 * collide with that grammar.
 */
export function normalizeDomainKey(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, "");
}

/** Assumes spec-engine/ exists: the caller runs assertSpecPlatform first. */
export function listDomainKeys(platformDir: string): string[] {
  const specsDir = join(platformDir, "spec-engine");
  return readdirSync(specsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(specsDir, e.name, "SPEC.json")))
    .map((e) => e.name)
    .sort();
}

/**
 * Any read or parse failure degrades to `null` rather than throwing, so
 * `domain list` and `spec req` never crash on a malformed domain dir.
 * Structural validation is `spec check`'s job, not the listing's.
 */
export async function domainScope(platformDir: string, key: string): Promise<string | null> {
  const { abs: jsonPath, rel: relFile } = specPaths(platformDir, key);
  if (!existsSync(jsonPath)) return null;
  let text: string;
  try {
    text = await Bun.file(jsonPath).text();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`spec: could not read scope for ${key}: ${msg}`);
    return null;
  }
  const parsed = parseDomainText(text, relFile);
  if (!parsed.ok) return null;
  const scope = parsed.data.scope;
  // A whitespace-only scope is no charter, so `domain list --json` and `spec req` agree.
  return scope === undefined || scope === null || scope.trim() === "" ? null : scope;
}

export async function domainsWithScope(
  platformDir: string,
): Promise<Array<{ key: string; scope: string | null }>> {
  const keys = listDomainKeys(platformDir);
  return Promise.all(
    keys.map(async (key) => ({ key, scope: await domainScope(platformDir, key) })),
  );
}

export function scaffoldDomainObject(key: string, today: string): SpecDomain {
  // @spec DOMAIN-019
  // A requirement domain's version is derived from its supersede graph and the
  // schema rejects an authored one. Only TERM is seeded with specVersion 1:
  // that counter is the term-drift pin, since a revise adds no supersede edge.
  // Key order here is immaterial: validateAndWrite rebuilds it.
  return {
    key,
    owner: null,
    ...(key === "TERM" ? { specVersion: 1 } : {}),
    updated: today,
    requirements: [] as SpecRequirement[],
  };
}

/** Max requirement sequence number across a domain's entries (0 if none). */
function maxSeqOf(requirements: readonly SpecRequirement[]): number {
  return requirements.reduce((m, r) => {
    const seq = Number(r.id.split("-")[1]);
    return Number.isFinite(seq) ? Math.max(m, seq) : m;
  }, 0);
}

/** The entries of a domain file's bytes; none when the bytes fail the schema. */
function requirementsOf(text: string, sourceFile: string): readonly SpecRequirement[] {
  const parsed = parseDomainText(text, sourceFile);
  return parsed.ok ? parsed.data.requirements : [];
}

/**
 * Max sequence number in the domain file as committed at HEAD, so an id whose
 * entry was deleted from the working tree cannot be re-minted for different
 * behavior (ids are permanent). Outside a git repo, with no HEAD, or on any git/parse failure this returns 0
 * and minting falls back to the working-tree max alone.
 */
async function headMaxSeq(platformDir: string, key: string): Promise<number> {
  // @spec REQ-018
  try {
    // `HEAD:./SPEC.json` resolves relative to -C, so this works no matter
    // where the platform sits inside the repo.
    const proc = Bun.spawn(
      ["git", "-C", join(platformDir, "spec-engine", key), "show", "HEAD:./SPEC.json"],
      { stdout: "pipe", stderr: "ignore", env: gitEnv() },
    );
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return 0;
    return maxSeqOf(requirementsOf(text, specPaths(platformDir, key).rel));
  } catch {
    return 0;
  }
}

/**
 * The max is taken over both the working tree and HEAD, so deleting an entry
 * never frees its id. A missing SPEC.json (the dir vanished between the
 * caller's listing and this read) yields `<KEY>-001`.
 */
export async function nextRequirementId(platformDir: string, key: string): Promise<string> {
  const { abs: jsonPath, rel: relFile } = specPaths(platformDir, key);
  if (!existsSync(jsonPath)) return `${key}-001`;
  const requirements = requirementsOf(await Bun.file(jsonPath).text(), relFile);
  const maxSeq = Math.max(maxSeqOf(requirements), await headMaxSeq(platformDir, key));
  const next = String(maxSeq + 1).padStart(3, "0");
  return `${key}-${next}`;
}
