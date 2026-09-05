// packages/engine/src/operations/domain.ts
//
// Domain lifecycle: scaffold a new `spec-engine/<KEY>/SPEC.json` and list the
// domains a platform holds. Both read the filesystem, never the index.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateAndWrite } from "@spec-engine/shared";
import { domainsWithScope, scaffoldDomainObject } from "../authoring/domains";
import { localToday } from "../authoring/edit";
import { specPaths } from "../constants";
import { fail, type OpFailure } from "./_result";

export interface NewDomainResult {
  ok: true;
  /** Platform-relative, e.g. `spec-engine/BILLING/SPEC.json`. */
  file: string;
}

/**
 * Scaffold a domain. `key` is already normalized and grammar-checked by the
 * surface. Refuses to write outside the platform, over an existing SPEC.json,
 * or beside a SPEC.md (a fresh empty SPEC.json would shadow it on the next
 * index).
 * @spec DOMAIN-014
 * @spec DOMAIN-015
 * @spec DOMAIN-019
 */
export async function newDomain(
  platformDir: string,
  key: string,
): Promise<NewDomainResult | OpFailure> {
  const { abs: dest, rel: relFile } = specPaths(platformDir, key);
  const resolvedDest = resolve(dest);
  const resolvedRoot = resolve(platformDir);
  if (!(resolvedDest === resolvedRoot || resolvedDest.startsWith(`${resolvedRoot}/`))) {
    return fail("usage", `refusing to write outside platformDir (${resolvedDest})`);
  }
  if (existsSync(dest)) return fail("conflict", `refusing to overwrite ${dest}`);
  if (existsSync(join(dirname(dest), "SPEC.md"))) {
    return fail(
      "conflict",
      `refusing to create ${dest}: domain ${key} already exists as spec-engine/${key}/SPEC.md ` +
        "— migrate the SPEC.md first (a fresh empty SPEC.json would shadow it on the next index)",
    );
  }
  mkdirSync(dirname(dest), { recursive: true });
  const res = await validateAndWrite(dest, scaffoldDomainObject(key, localToday()), relFile);
  if (!res.ok) {
    return fail("invalid_domain_file", res.diagnostics.map((d) => d.detail).join("\n"), {
      diagnostics: res.diagnostics,
    });
  }
  return { ok: true, file: relFile };
}

/** Every domain with its charter sentence (null when unset), sorted by key. */
// @spec DOMAIN-017
export async function listDomains(platformDir: string) {
  return { ok: true as const, domains: await domainsWithScope(platformDir) };
}
