// Everything that reads files or git runs after runIndex, so no flag can
// perturb `build_id` and the cold-rebuild identity.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Diagnostic,
  parseDomainText,
  type SpecRequirement,
  type Storage,
  type Tag,
} from "@spec-engine/shared";
import { gitLsTree, gitRefResolves, gitShow } from "../base/gitBase";
import { parseCodeowners } from "../check/codeowners";
import { duplicateDiagnostics, duplicateThreshold } from "../check/duplicates";
import { statementGrammarDiagnostics } from "../check/grammar";
import { changedRules, partialPropagation } from "../check/propagation-teeth";
import { provenDetermination } from "../check/proven";
import { requirementRemoved } from "../check/removed";
import { applySeverity, readCheckConfig } from "../check/severity";
import { collectDiagnostics } from "../check/sqlDiagnostics";
import { statementRulesDiagnostics } from "../check/statementRules";
import { unapprovedStatusFlip } from "../check/statusflip";
import { supersedesPointerDiagnostics } from "../check/supersedes";
import { unsourcedChanges } from "../check/unsourced";
import { CANONICAL_SPECS_DIR, SPEC_FILENAME } from "../constants";
import type { Loss } from "../guard/losses";
import { runIndex } from "../indexer/pipeline";
import { parseJUnit, type TestCaseResult } from "../results/junit";
import { findDomainJsonFiles, isPathIgnored } from "../scanner/fs";
import { fail, type OpFailure } from "./_result";
import { glossaryDriftDiagnostic } from "./glossary";
import { guard } from "./guard";
import { migrationPendingDiagnostics } from "./migrate";

export interface CheckInput {
  platformDir: string;
  /** Absolute path to a JUnit XML file, already containment-checked by the surface. */
  resultsPath?: string | undefined;
  /** Git ref for the governance diff. Absent: deletion detection against HEAD when git resolves. */
  base?: string | undefined;
  /** Comma-separated approver handles for the status-flip gate. Empty is fail-closed. */
  approvedBy?: string | undefined;
  requireOwnerApproval?: boolean | undefined;
  unsourcedChange?: boolean | undefined;
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
  const validated = parseDomainText(text, platformRel);
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

  // @spec OWNER-003
  // @spec OWNER-004
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

// @spec GUARD-034
// @spec GUARD-035
const LOSS_SEVERITY: Record<
  Exclude<Loss["kind"], "REQUIREMENT_REMOVED">,
  Diagnostic["severity"]
> = {
  IMPL_LOST: "error",
  SPEC_FILE_DELETED: "error",
  VERIFY_LOST: "warning",
};

/** Guard's losses against `ref` as check rows. The removal check owns REQUIREMENT_REMOVED. */
// @spec GUARD-024
// @spec GUARD-026
async function lossDiagnostics(
  storage: Storage,
  platformDir: string,
  ref: string,
): Promise<Diagnostic[]> {
  const { losses } = await guard(storage, platformDir, ref);
  const rows: Diagnostic[] = [];
  for (const loss of losses) {
    if (loss.kind === "REQUIREMENT_REMOVED") continue;
    rows.push({
      code: loss.kind,
      severity: LOSS_SEVERITY[loss.kind],
      repo: null,
      source_file: loss.file === "" ? null : loss.file,
      line: loss.line,
      req_id: loss.req_id,
      detail: loss.detail,
    });
  }
  return rows;
}

/**
 * Run the full check into `storage`. Fails `usage` when `base` does not
 * resolve (a governance gate must never fail open). A JUnit parse failure
 * throws, which every surface reports as a crash rather than a diagnostic.
 * @spec CHCK-012
 * @spec CHCK-061
 * @spec CHCK-059
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
  // @spec CHCK-039
  const checkConfig = readCheckConfig(platformDir);
  if (!checkConfig.ok) return fail("usage", checkConfig.detail);
  const diagnostics = collectDiagnostics(storage);

  if (input.unsourcedChange) {
    const superseded = storage.listRequirements({ status: "Superseded" });
    diagnostics.push(...unsourcedChanges(superseded, storage.listProvenance()));
  }
  // @spec CHCK-008
  diagnostics.push(...(await statementGrammarDiagnostics(platformDir)));
  diagnostics.push(
    ...(await statementRulesDiagnostics(platformDir, checkConfig.config.statementRules)),
  );
  const threshold = duplicateThreshold(checkConfig.config.duplicates);
  if (threshold !== null) diagnostics.push(...duplicateDiagnostics(storage, threshold));
  // @spec CHCK-029
  diagnostics.push(...(await supersedesPointerDiagnostics(platformDir)));
  diagnostics.push(...(await migrationPendingDiagnostics(platformDir)));
  const glossaryDrift = glossaryDriftDiagnostic(platformDir);
  if (glossaryDrift !== null) diagnostics.push(glossaryDrift);

  const results = await ingestResults(storage, input.resultsPath, diagnostics);

  if (input.base) {
    await governanceGate(input, input.base, diagnostics, results);
    diagnostics.push(...(await lossDiagnostics(storage, platformDir, input.base)));
  } else if (gitRefResolves(platformDir, "HEAD")) {
    // @spec CHCK-023
    const change = await collectChangeReqs(join(platformDir, CANONICAL_SPECS_DIR));
    const baseParseSink: Diagnostic[] = [];
    const base = collectBaseReqs(platformDir, "HEAD", baseParseSink);
    diagnostics.push(
      ...requirementRemoved(base.reqs, change.reqs, (id) => base.relPathById.get(id) ?? null),
    );
    diagnostics.push(...(await lossDiagnostics(storage, platformDir, "HEAD")));
  }

  const graded = applySeverity(diagnostics, checkConfig.config.severity);
  return {
    ok: true,
    diagnostics: graded,
    buildId: result.build_id,
    failing: graded.some((d) => d.severity === "error"),
    proofsUnconfirmed: !input.resultsPath,
  };
}
