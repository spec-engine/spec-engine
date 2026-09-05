// packages/engine/src/operations/nextId.ts
//
// Resolve a domain from a key or unique case-insensitive prefix, and preview
// the next unused requirement id in it. Nothing is written.

import { listDomainKeys, nextRequirementId, normalizeDomainKey } from "../authoring/domains";
import { fail, type OpFailure } from "./_result";

export interface ResolvedDomain {
  ok: true;
  key: string;
}

/**
 * Exact match wins; otherwise a single prefix match resolves. An ambiguous
 * prefix or no match is a `usage` failure whose detail lists the candidates.
 * The input is never used to build a filesystem path; only enumerated keys are.
 */
export function resolveDomain(platformDir: string, input: string): ResolvedDomain | OpFailure {
  const prefix = normalizeDomainKey(input);
  const keys = listDomainKeys(platformDir);
  if (keys.includes(prefix)) return { ok: true, key: prefix };
  const matches = keys.filter((k) => k.startsWith(prefix));
  const [only, ...rest] = matches;
  if (only !== undefined && rest.length === 0) return { ok: true, key: only };
  if (matches.length > 1) {
    return fail("usage", `"${input}" is ambiguous — candidates: ${matches.join(", ")}`);
  }
  const available = keys.length > 0 ? keys.join(", ") : "(none)";
  return fail("usage", `no domain matches "${input}" — available: ${available}`);
}

export interface NextIdResult {
  ok: true;
  key: string;
  nextId: string;
}

/** The next unused `KEY-NNN` in the resolved domain (max seq + 1, zero-padded). */
export async function nextId(
  platformDir: string,
  input: string,
): Promise<NextIdResult | OpFailure> {
  const resolved = resolveDomain(platformDir, input);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    key: resolved.key,
    nextId: await nextRequirementId(platformDir, resolved.key),
  };
}
