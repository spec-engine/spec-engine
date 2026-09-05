// packages/engine/src/operations/check.ts
//
// The integrity check: build the index into the caller's handle, then run
// every diagnostic pass. Everything that reads files or git runs AFTER
// runIndex, so `build_id` is fixed the instant the index is built and no
// flag can perturb the cold-rebuild identity.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Diagnostic,
  DiagnosticCode,
  type SpecRequirement,
  type Storage,
  type Tag,
  validateDomainFile,
} from "@spec-engine/shared";
import { gitLsTree, gitRefResolves, gitShow } from "../base/gitBase";
import { parseCodeowners } from "../check/codeowners";
import { brokenFileRefDiagnostics } from "../check/filerefs";
import { statementGrammarDiagnostics } from "../check/grammar";
import { changedRules, partialPropagation } from "../check/propagation-teeth";
import { provenDetermination } from "../check/proven";
import { requirementRemoved } from "../check/removed";
import { collectDiagnostics } from "../check/sqlDiagnostics";
import { unapprovedStatusFlip } from "../check/statusflip";
import { supersedesPointerDiagnostics } from "../check/supersedes";
import { unsourcedChanges } from "../check/unsourced";
import { CANONICAL_SPECS_DIR, SPEC_FILENAME } from "../constants";
import { runIndex } from "../indexer/pipeline";
import { parseJUnit, type TestCaseResult } from "../results/junit";
import { findDomainJsonFiles, isPathIgnored } from "../scanner/fs";
import { fail, type OpFailure } from "./_result";
import { glossaryDriftDiagnostic } from "./glossary";

export interface CheckInput {
  platformDir: string;
  /** Absolute path to a JUnit XML file, already containment-checked by the surface. */
  resultsPath?: string;
  /** Git ref for the governance diff. Absent: deletion detection against HEAD when git resolves. */
  base?: string;
  /** Comma-separated approver handles for the status-flip gate. Empty is fail-closed. */
  approvedBy?: string;
  requireOwnerApproval?: boolean;
  unsourcedChange?: boolean;
}

export interface CheckResult {
  ok: true;
  /** Unsorted; the renderer owns the order. */
  diagnostics: Diagnostic[];
  buildId: string;
  /** True when any diagnostic is error-severity: the gate is red. */
  failing: boolean;
  /** True when no results file was given, so proof-of-passing was not enforced. */
  proofsUnconfirmed: boolean;
}

interface DomainReqSet {
  reqs: SpecRequirement[];
  relPathById: Map<string, string>;
}

interface IngestedResults {
  resultsParsed: TestCaseResult[] | undefined;
  verifyingTags: Tag[] | undefined;
}

function readCodeownersText(platformDir: string): string | null {
  const path = join(platformDir, ".github", "CODEOWNERS");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

/** Domain-file bytes to requirements through the one validator. Never throws:
 *  a malformed body yields INVALID_DOMAIN_FILE and zero requirements. */
function domainReqsFromText(
  text: string,
  platformRel: string,
): { reqs: readonly SpecRequirement[]; diagnostics: Diagnostic[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      reqs: [],
      diagnostics: [
        {
          code: DiagnosticCode.INVALID_DOMAIN_FILE,
          source_file: platformRel,
          line: 0,
          repo: null,
          req_id: null,
          detail: `not valid JSON: ${msg}`,
          severity: "error",
        },
      ],
    };
  }
  const validated = validateDomainFile(parsed, platformRel);
  if (!validated.ok) return { reqs: [], diagnostics: validated.diagnostics };
  return { reqs: validated.data.requirements, diagnostics: [] };
}

/** The working-tree side of a governance diff. Parse diagnostics are not
 *  re-emitted here: runIndex already surfaced them with the same source_file. */
async function collectChangeReqs(canonicalDir: string): Promise<DomainReqSet> {
  const reqs: SpecRequirement[] = [];
  const relPathById = new Map<string, string>();
  for (const rel of await findDomainJsonFiles(canonicalDir)) {
    const platformRel = `${CANONICAL_SPECS_DIR}/${rel}`;
    const text = await Bun.file(join(canonicalDir, rel)).text();
    const parsed = domainReqsFromText(text, platformRel);
    for (const r of parsed.reqs) {
      reqs.push(r);
      relPathById.set(r.id, platformRel);
    }
  }
  return { reqs, relPathById };
}

/** The ref side of a governance diff, enumerated from the ref itself so a
 *  wholesale-deleted domain file still surfaces its removed ids. The same
 *  ignore rules as the working-tree side apply. */
function collectBaseReqs(
  platformDir: string,
  ref: string,
  diagnostics: Diagnostic[],
): DomainReqSet {
  const reqs: SpecRequirement[] = [];
  const relPathById = new Map<string, string>();
  for (const path of gitLsTree(platformDir, ref, CANONICAL_SPECS_DIR)) {
    if (!path.endsWith(`/${SPEC_FILENAME}`)) continue;
    if (isPathIgnored(path)) continue;
    const bytes = gitShow(platformDir, ref, path);
    if (bytes === null) continue;
    const parsed = domainReqsFromText(bytes, path);
    diagnostics.push(...parsed.diagnostics);
    for (const r of parsed.reqs) {
      reqs.push(r);
      relPathById.set(r.id, path);
    }
  }
  return { reqs, relPathById };
}

/** Trusted-red: a verifying tag counts only when its test passed. */
async function ingestResults(
  storage: Storage,
  resultsPath: string | undefined,
  diagnostics: Diagnostic[],
): Promise<IngestedResults> {
  if (!resultsPath) return { resultsParsed: undefined, verifyingTags: undefined };
  const xml = await Bun.file(resultsPath).text();
  const resultsParsed = parseJUnit(xml);
  const verifyingTags = storage.listTags().filter((t) => t.kind === "verifies");
  const active = storage.listRequirements({ status: "Active" });
  diagnostics.push(...provenDetermination(active, verifyingTags, resultsParsed));
  return { resultsParsed, verifyingTags };
}

/** The `--base` governance gate: removals, unapproved status flips, and partial
 *  propagation (the last only with results). */
async function governanceGate(
  input: CheckInput,
  ref: string,
  diagnostics: Diagnostic[],
  results: IngestedResults,
): Promise<void> {
  const { platformDir } = input;
  const change = await collectChangeReqs(join(platformDir, CANONICAL_SPECS_DIR));
  const base = collectBaseReqs(platformDir, ref, diagnostics);

  diagnostics.push(
    ...requirementRemoved(base.reqs, change.reqs, (id) => base.relPathById.get(id) ?? null),
  );

  // @spec OWNER-002
  const codeowners = parseCodeowners(readCodeownersText(platformDir) ?? "");
  const approvedBy = (input.approvedBy ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  diagnostics.push(
    ...unapprovedStatusFlip(
      base.reqs,
      change.reqs,
      codeowners,
      approvedBy,
      (id) => change.relPathById.get(id) ?? null,
      !!input.requireOwnerApproval,
    ),
  );

  if (results.resultsParsed !== undefined && results.verifyingTags !== undefined) {
    diagnostics.push(
      ...partialPropagation(
        changedRules(base.reqs, change.reqs),
        results.verifyingTags,
        results.resultsParsed,
        (id) => change.relPathById.get(id) ?? null,
      ),
    );
  }
}

/**
 * Run the full check into `storage`. Fails `usage` when `base` does not
 * resolve (a governance gate must never fail open). A JUnit parse failure
 * throws, which every surface reports as a crash rather than a diagnostic.
 * @spec CHCK-012
 * @spec CHCK-013
 * @spec CHCK-025
 */
export async function check(input: CheckInput, storage: Storage): Promise<CheckResult | OpFailure> {
  const { platformDir } = input;
  if (input.base && !gitRefResolves(platformDir, input.base)) {
    return fail(
      "usage",
      `--base ref '${input.base}' does not resolve in ${platformDir} ` +
        "(not a git repo, or the ref is unfetched/misspelled) — refusing to run the governance gate fail-open",
    );
  }

  const result = await runIndex({ platformDir, storage });
  const diagnostics = collectDiagnostics(storage);

  if (input.unsourcedChange) {
    const superseded = storage.listRequirements({ status: "Superseded" });
    diagnostics.push(...unsourcedChanges(superseded, storage.listProvenance()));
  }
  // @spec CHCK-008
  diagnostics.push(...(await statementGrammarDiagnostics(platformDir)));
  // @spec CHCK-026
  diagnostics.push(...(await brokenFileRefDiagnostics(platformDir)));
  // @spec CHCK-029
  diagnostics.push(...(await supersedesPointerDiagnostics(platformDir)));
  const glossaryDrift = glossaryDriftDiagnostic(platformDir);
  if (glossaryDrift !== null) diagnostics.push(glossaryDrift);

  const results = await ingestResults(storage, input.resultsPath, diagnostics);

  if (input.base) {
    await governanceGate(input, input.base, diagnostics, results);
  } else if (gitRefResolves(platformDir, "HEAD")) {
    // @spec CHCK-023
    const change = await collectChangeReqs(join(platformDir, CANONICAL_SPECS_DIR));
    const baseParseSink: Diagnostic[] = [];
    const base = collectBaseReqs(platformDir, "HEAD", baseParseSink);
    diagnostics.push(
      ...requirementRemoved(base.reqs, change.reqs, (id) => base.relPathById.get(id) ?? null),
    );
  }

  return {
    ok: true,
    diagnostics,
    buildId: result.build_id,
    failing: diagnostics.some((d) => d.severity === "error"),
    proofsUnconfirmed: !input.resultsPath,
  };
}
