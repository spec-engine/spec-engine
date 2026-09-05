// packages/engine/src/operations/mint.ts
//
// Author a new Active requirement into a domain's SPEC.json. One function for
// every surface: `spec req --text`, the interactive `spec req` flow, the HTTP
// editor's POST, and the MCP client all end here. The whole envelope is
// written through the single validateAndWrite seam.

import { existsSync } from "node:fs";
import {
  type EarsClauses,
  parseEarsStatement,
  type SpecCite,
  validateAndWrite,
} from "@spec-engine/shared";
import { nextRequirementId } from "../authoring/domains";
import { localToday } from "../authoring/edit";
import { extractRefsFromText, resolveFileRef } from "../authoring/filerefs";
import {
  grammarRefusalText,
  grammarWarningText,
  judgeStatementGrammar,
} from "../authoring/grammar";
import { specPaths } from "../constants";
import { fail, type OpFailure, type OpWarning } from "./_result";

export interface MintInput {
  platformDir: string;
  /** An enumerated domain key (resolve a prefix with `resolveDomain` first). */
  key: string;
  statement: string;
  why: string;
  livesIn: string[];
  /** Originating ticket, recorded as `created` provenance. Opaque, never an id. */
  issue?: string;
  /** Defaults to `active`. A `draft` is a promise not yet agreed; code may not bind it. */
  status?: "active" | "draft";
  /** Ids this requirement relates to; rendered by `spec relations`. */
  relates?: string[];
  /** Pinned glossary citations. */
  cites?: SpecCite[];
}

export interface MintResult {
  ok: true;
  id: string;
  /** Platform-relative spec path, e.g. `spec-engine/BILLING/SPEC.json`. */
  file: string;
  /** The parsed EARS clauses when the statement conforms; absent otherwise. */
  clauses?: EarsClauses;
  warnings: OpWarning[];
}

/** One warning per `@<path>` ref in the given field values that does not resolve under the platform. */
export function unresolvableRefWarnings(platformDir: string, fieldValues: string[]): OpWarning[] {
  const out: OpWarning[] = [];
  for (const value of fieldValues) {
    for (const ref of extractRefsFromText(value)) {
      if (!resolveFileRef(platformDir, ref)) {
        out.push({ kind: "ref", text: `@${ref} does not resolve under ${platformDir}` });
      }
    }
  }
  return out;
}

/**
 * Allocate the next id, append the entry, bump the envelope's `updated`, and
 * write. Fails `not_found` when the domain has no SPEC.json, `usage` when the
 * domain's grammar severity refuses the statement, `invalid_domain_file` when
 * the shared validator rejects the resulting envelope.
 * @spec SCHM-024
 */
export async function mint(input: MintInput): Promise<MintResult | OpFailure> {
  const { platformDir, key } = input;
  const { abs: specPath, rel: relFile } = specPaths(platformDir, key);
  if (!existsSync(specPath)) {
    return fail("not_found", `no domain ${key} (expected ${relFile} under ${platformDir})`);
  }
  const warnings = unresolvableRefWarnings(platformDir, [
    input.statement,
    input.why,
    ...input.livesIn,
  ]);
  const verdict = await judgeStatementGrammar(platformDir, key, input.statement);
  if (!verdict.ok) {
    if (verdict.severity === "error") {
      return fail("usage", grammarRefusalText("", verdict).slice(2), { warnings });
    }
    warnings.push({ kind: "grammar", text: grammarWarningText("", verdict).slice(2) });
  }

  let domain: { requirements?: unknown[]; updated?: string; [k: string]: unknown };
  try {
    domain = JSON.parse(await Bun.file(specPath).text());
  } catch {
    return fail("invalid_domain_file", `${relFile} is not valid JSON`, { warnings });
  }
  const id = await nextRequirementId(platformDir, key);
  const requirements = Array.isArray(domain.requirements) ? domain.requirements : [];
  requirements.push({
    id,
    status: input.status ?? "active",
    statement: input.statement,
    why: input.why || null,
    supersedes: null,
    supersededBy: null,
    relates: input.relates ?? [],
    livesIn: input.livesIn,
    // @spec PROV-003
    issues: input.issue ? [{ role: "created", id: input.issue }] : [],
    cites: input.cites ?? [],
  });
  domain.requirements = requirements;
  domain.updated = localToday();

  const res = await validateAndWrite(specPath, domain, relFile);
  if (!res.ok) {
    return fail("invalid_domain_file", res.diagnostics.map((d) => d.detail).join("\n"), {
      diagnostics: res.diagnostics,
      warnings,
    });
  }
  const parsed = parseEarsStatement(input.statement);
  return parsed.ok
    ? { ok: true, id, file: relFile, clauses: parsed.clauses, warnings }
    : { ok: true, id, file: relFile, warnings };
}
