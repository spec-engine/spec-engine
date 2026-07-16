// packages/engine/src/authoring/domains.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec DOMAIN-001
// @spec DOMAIN-007
// @spec REQ-005
// @spec approve AUTHC-017 import-count rule evicted to AGENTS.md + the D-08 CI fence (§4.5 dev convention, not a product promise)
//
// Shared substrate for the noun-verb authoring surface:
// `spec domain new`, `spec domain list`,
// and `spec req` all consume these helpers so the normalization rule,
// the KEY grammar, and the next-id computation live in exactly one place.
//
// AUTHC-001: normalization is uppercase + strip ALL whitespace — NEVER
// dash-substitution. `-` is reserved as the key/seq separator in a
// requirement id (`<KEY>-<NNN>`), so a dashed key (`USER-AUTH`) would
// collide with that grammar.
//
// AUTHC-007: domains are enumerated from the FILESYSTEM (canonical truth
// per CLAUDE.md) — never the derived index, never a cache file.
//
// D-08: NO bun:sqlite import here (system-wide count stays at 1 —
// storage/sqlite.ts:7). Dependencies are node:fs, node:path only.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Canonical domain-key grammar (`KEY`): CANONICALLY defined in
// @spec-engine/shared (P3 consolidation) and re-exported here so the existing
// `../authoring/domains` importers (commands/domain.ts) are unchanged.
export { KEY_RE } from "@spec-engine/shared";

/**
 * AUTHC-001: canonicalize a user-supplied domain name. Uppercase and strip
 * ALL whitespace ("user auth" → "USERAUTH", "aUtH" → "AUTH"). Spaces are
 * NEVER converted to dashes — see the HEAD_RE rationale in the file header.
 */
export function normalizeDomainKey(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, "");
}

/**
 * AUTHC-007/008: enumerate domain keys from `<platformDir>/spec-engine/`.
 * A domain is a child DIRECTORY that contains a SPEC.json (the JSON write
 * format, 17-04). Post-cutover (Phase 18, D2) SPEC.json is the ONLY spec
 * format — the Markdown read path is deleted — so the listing (used by
 * `domain list` and `spec req` prefix resolution) recognizes SPEC.json
 * only. Returns the names sorted lexicographically. The caller is
 * responsible for the platform guard (assertSpecPlatform) — this helper
 * assumes spec-engine/ exists.
 */
export function listDomainKeys(platformDir: string): string[] {
  const specsDir = join(platformDir, "spec-engine");
  return readdirSync(specsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(specsDir, e.name, "SPEC.json")))
    .map((e) => e.name)
    .sort();
}

/**
 * CHRT-004: read a domain's charter `scope` straight from the FILESYSTEM
 * (`<platformDir>/spec-engine/<key>/SPEC.json`), never the derived index — the
 * D-08 no-`bun:sqlite` fence stays green (the read idiom mirrors
 * `nextRequirementId`). Returns the `scope` string when the envelope carries a
 * non-blank string one, else `null` — a missing file, unparseable JSON, or an
 * absent/non-string/whitespace-only `scope` all degrade to `null` (no throw),
 * so `domain list` and `spec req` never crash on a malformed domain dir and
 * agree on whether a charter is set. (A structurally-invalid-but-parseable
 * envelope may still surface its `scope` here — full structural validation is
 * `spec check`'s job, not the listing's.)
 */
export async function domainScope(platformDir: string, key: string): Promise<string | null> {
  const jsonPath = join(platformDir, "spec-engine", key, "SPEC.json");
  if (!existsSync(jsonPath)) return null;
  try {
    const env = JSON.parse(await Bun.file(jsonPath).text()) as { scope?: unknown };
    // Normalize blank-to-null once here so `domain list --json` and
    // `spec req`'s charter print agree: a whitespace-only scope ≡ no charter.
    if (typeof env.scope !== "string" || env.scope.trim() === "") return null;
    return env.scope;
  } catch (e) {
    // Malformed/partial JSON is the listing's business to ignore (the
    // structural reject is `spec check`'s job). A real IO fault (permission /
    // lock) is an environment problem worth surfacing on the chrome channel.
    if (e instanceof SyntaxError) return null;
    console.error(`spec: could not read scope for ${key}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * CHRT-004: the sorted `{ key, scope }` listing `domain list --json` emits —
 * `listDomainKeys` (already sorted) composed with a filesystem `domainScope`
 * read per key. Kept here so the FS-read idiom lives in exactly one place and
 * the command file stays index-free (D-08).
 */
export async function domainsWithScope(
  platformDir: string,
): Promise<Array<{ key: string; scope: string | null }>> {
  const keys = listDomainKeys(platformDir);
  return Promise.all(
    keys.map(async (key) => ({ key, scope: await domainScope(platformDir, key) })),
  );
}

/**
 * AUTHC-004: the fresh-domain envelope OBJECT for `key` (STOR-02 shape). The
 * plain object is handed to `validateAndWrite` (17-01), which validates it
 * through the same `validateDomainFile` the index uses and serializes it with
 * a fixed key order + single trailing newline — so there is no bespoke
 * Markdown/JSON text write here. `owner` is explicit `null` (byte-stable),
 * `requirements` empty, and NO authored `specVersion` for a requirement domain
 * (DOMAIN-010 / SCHM-008) — only the reserved TERM domain is seeded with
 * `specVersion` 1.
 */
export function scaffoldDomainObject(key: string, today: string) {
  // @spec DOMAIN-010 — a requirement (non-TERM) domain is born WITHOUT an
  // authored specVersion: its version is the DAG-derived projection (SCHM-007)
  // and the schema rejects an authored counter on a non-TERM domain (SCHM-008).
  // Only the reserved TERM domain is seeded with specVersion 1 — that authored
  // counter is the term-drift pin (a revise adds no supersede edge to derive).
  // Key order here is immaterial: validateAndWrite → orderDomain rebuilds it.
  return {
    key,
    owner: null,
    ...(key === "TERM" ? { specVersion: 1 } : {}),
    updated: today,
    requirements: [] as unknown[],
  };
}

/**
 * AUTHC-014: next unused requirement id for `key`. Reads the domain's
 * `SPEC.json` (the sole spec format post-cutover, Phase 18 / D2) and
 * computes `max(seq)+1` across `requirements[].id`
 * (seq = `Number(id.split("-")[1])`), padded to 3 digits. Defensive
 * `<KEY>-001` when no `SPEC.json` exists (e.g. the dir vanished between
 * the caller's listing and this read).
 */
export async function nextRequirementId(platformDir: string, key: string): Promise<string> {
  const jsonPath = join(platformDir, "spec-engine", key, "SPEC.json");
  if (!existsSync(jsonPath)) return `${key}-001`;
  const domain = JSON.parse(await Bun.file(jsonPath).text()) as {
    requirements?: Array<{ id?: unknown }>;
  };
  const reqs = Array.isArray(domain.requirements) ? domain.requirements : [];
  const maxSeq = reqs.reduce((m, r) => {
    const id = typeof r?.id === "string" ? r.id : "";
    const seq = Number(id.split("-")[1]);
    return Number.isFinite(seq) ? Math.max(m, seq) : m;
  }, 0);
  const next = String(maxSeq + 1).padStart(3, "0");
  return `${key}-${next}`;
}
