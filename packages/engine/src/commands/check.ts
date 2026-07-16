// packages/engine/src/commands/check.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec CHCK-001
// @spec CHCK-002
// @spec CHCK-003
//
// `spec check [platformDir] [--out <path>] [--ci] [--json]` — citty
// subcommand for the cross-repo integrity check (CHCK-01 / CHCK-02 /
// CHCK-04).
//
// Behavior:
//   - `--ci` literally rm's `dbPath`, `dbPath + "-wal"`, `dbPath + "-shm"`
//     BEFORE `openStorage` is called. Mirrors `storage/sqlite.ts:80-82`
//     and ci.yml smoke 6. Cold rebuild is mechanical, not aspirational
//     (Invariant #2 — "CI gate can run cold").
//   - Without `--ci`: if the DB file is missing, `openStorage` builds it
//     fresh; if present, it's reused. Either way `runIndex` populates
//     the DB before we read diagnostics.
//   - Output: text or JSON (CHCK-02 / CHCK-04 format). The formatter
//     (check/format.ts) owns sort order + serialization shape.
//   - Exit codes: 0 (clean), 1 (any error-severity diagnostic),
//     2 (command crash / bad args / path-containment violation).
//
// V12 path-containment: if `--out` is supplied, the resolved path MUST
// stay under `resolve(platformDir)`. Reusing the guard pattern from
// `commands/domain.ts` (domainNewCommand) so a malicious or accidentally-
// typo'd `--out` cannot rm a file outside the workspace.
//
// D-08 grep-fence: this file does NOT import bun:sqlite. DB access goes
// exclusively through the Storage interface from @spec-engine/shared.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type Diagnostic,
  DiagnosticCode,
  NotASpecPlatformError,
  type SpecRequirement,
  type Storage,
  type Tag,
  validateDomainFile,
} from "@spec-engine/shared";
import { defineCommand } from "citty";
import { gitLsTree, gitRefResolves, gitShow } from "../base/gitBase";
import { parseCodeowners } from "../check/codeowners";
import { renderDiagnostics } from "../check/format";
import { changedRules, partialPropagation } from "../check/propagation-teeth";
import { proofsUnconfirmedWarning, provenDetermination } from "../check/proven";
import { requirementRemoved } from "../check/removed";
import { collectDiagnostics } from "../check/sqlDiagnostics";
import { unapprovedStatusFlip } from "../check/statusflip";
import { unsourcedChanges } from "../check/unsourced";
import { EXIT, isContainedPath, OUT_HELP, resolveDbPath } from "../constants";
import { assertSpecPlatform, formatNotASpecPlatform } from "../indexer/discover";
import { runIndex } from "../indexer/pipeline";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { parseJUnit, type TestCaseResult } from "../results/junit";
import { findDomainJsonFiles, isPathIgnored } from "../scanner/fs";
import { openStorage } from "../storage/sqlite";
import { assertContainedPath, coldResetDb } from "./_shared";

// A parsed set of domain requirements plus the platform-relative path each id
// was sourced from — the shape returned by BOTH collectChangeReqs (working
// tree) and collectBaseReqs (a git ref), so the governance gate diffs two
// identically-shaped sides.
interface DomainReqSet {
  reqs: SpecRequirement[];
  relPathById: Map<string, string>;
}

// The JUnit results + verifying @spec tags parsed ONCE by the results-ingest
// stage. Hoisted so the --base governance/propagation stage can reuse them for
// PROOF-007 without re-reading/re-parsing. Both stay `undefined` unless --results
// supplied a valid, contained file.
interface IngestedResults {
  resultsParsed: TestCaseResult[] | undefined;
  verifyingTags: Tag[] | undefined;
}

// The subset of parsed CLI args the governance gate reads. approvedBy is
// FAIL-CLOSED (empty = no approver); requireOwnerApproval escalates the
// status-flip tier. See the arg definitions on checkCommand for the full
// GOV-02 / T-20-04 trust-boundary notes.
interface GovernanceArgs {
  base: string | undefined;
  approvedBy: string | undefined;
  requireOwnerApproval: boolean | undefined;
}

// Read `<platformDir>/.github/CODEOWNERS`, or null when absent. The pure
// parseCodeowners grammar (20-01, ReDoS-safe) owns the text→rules mapping; this
// helper is the ONLY filesystem touch for owner resolution.
function readCodeownersText(platformDir: string): string | null {
  const path = join(platformDir, ".github", "CODEOWNERS");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

// Parse domain-file BYTES → SpecRequirement[] through the ONE structural
// validator (VAL-02, base==change parse). A malformed body (bad JSON OR schema
// reject) yields INVALID_DOMAIN_FILE-shaped diagnostics and ZERO requirements —
// it must NEVER throw, so a malformed BASE cannot crash the gate into exit 2
// (T-20-02). Mirrors parseDomainJsonFile's JSON.parse try/catch.
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

// Results-ingest stage — GATE-01/GATE-02 (trusted-red) + GATE-05 (no-results
// fallback). Called AFTER runIndex returns, so `build_id` (hashed inside
// runIndex) can never be perturbed by --results — GATE-04's cold-build
// byte-identity holds by construction (temporal isolation). The push is BEFORE
// renderDiagnostics, so the formatter owns sort order, and the unchanged
// `severity === "error"` exit predicate flips the exit to 1 on any UNPROVEN_REQ
// with zero predicate change. Returns the parsed JUnit results + verifying tags
// so the --base governance/propagation block can reuse them for PROOF-007
// without re-reading/re-parsing; both stay `undefined` unless --results supplied a
// valid, contained file.
async function ingestResults(
  storage: Storage,
  platformDir: string,
  resultsArg: string | undefined,
  jsonMode: boolean,
  diagnostics: Diagnostic[],
): Promise<IngestedResults> {
  if (!resultsArg) {
    // GATE-05 gradual-adoption fallback: with NO --results, today's exit
    // code is byte-preserved. In --json mode the PROOFS_UNCONFIRMED advisory
    // goes to STDERR so the stdout diagnostic array stays byte-identical
    // (Pitfall 3 — the inverted-CI --json baselines at ci.yml smoke 7/18
    // must not gain a row). In text mode it is a visible warning row.
    if (jsonMode) {
      console.error(
        "spec check: no --results supplied; proofs unconfirmed (PROOFS_UNCONFIRMED) — run with --results <junit.xml> to enforce trusted-red",
      );
    } else {
      diagnostics.push(proofsUnconfirmedWarning());
    }
    return { resultsParsed: undefined, verifyingTags: undefined };
  }

  // T-19-04 V12 path-containment: resolve --results against platformDir
  // (NOT cwd) and exit 2 if it escapes the workspace — the exact guard
  // shape used for --out above. Blocks `--results ../../etc/passwd`.
  const resultsPath = resolve(platformDir, resultsArg);
  if (!isContainedPath(resultsPath, platformDir)) {
    console.error(
      `spec check: --results path must be inside platformDir (resolved to ${resultsPath})`,
    );
    // IN-01: storage is already open on this containment-failure path
    // (unlike the pre-open --out guard). process.exit skips finally, so
    // close the handle explicitly before exiting — matching the happy-path
    // close-before-exit and the catch block. Swallow a secondary close
    // failure so the containment message remains the visible reason.
    try {
      storage.close();
    } catch {
      // Already exiting 2 — ignore a close failure on a half-open DB.
    }
    process.exit(EXIT.USAGE);
  }

  // The read + parse stay inside the caller's try: a malformed-XML
  // JUnitParseError (or an I/O failure) surfaces as exit 2 (crash) via the
  // existing catch, distinct from exit 1 (diagnostic) — T-19-03 keeps the CI
  // exit-code contract unambiguous.
  const xml = await Bun.file(resultsPath).text();
  const resultsParsed = parseJUnit(xml);
  const verifyingTags = storage.listTags().filter((t) => t.kind === "verifies");
  const active = storage.listRequirements({ status: "Active" });
  diagnostics.push(...provenDetermination(active, verifyingTags, resultsParsed));
  return { resultsParsed, verifyingTags };
}

// Change side of the governance diff: the working-tree domain JSON →
// SpecRequirement[] through the ONE validator (VAL-02). A malformed change file
// surfaces INVALID_DOMAIN_FILE and contributes zero reqs — it does not throw.
async function collectChangeReqs(canonicalDir: string): Promise<DomainReqSet> {
  const reqs: SpecRequirement[] = [];
  const relPathById = new Map<string, string>();
  for (const rel of await findDomainJsonFiles(canonicalDir)) {
    const platformRel = `spec-engine/${rel}`;
    const text = await Bun.file(join(canonicalDir, rel)).text();
    // WR-01: change-side files were already parsed by runIndex, whose
    // INVALID_DOMAIN_FILE rows collectDiagnostics already surfaced with the
    // SAME platform-relative source_file. Re-pushing parseDiags here would
    // emit a byte-identical duplicate under --base — take only the reqs.
    const parsed = domainReqsFromText(text, platformRel);
    for (const r of parsed.reqs) {
      reqs.push(r);
      relPathById.set(r.id, platformRel);
    }
  }
  return { reqs, relPathById };
}

// Base side of the governance diff: enumerate from the REF via `git ls-tree`
// (NOT the working tree) so a wholesale-deleted domain file still surfaces its
// removed ids (Pitfall 3). `git show` reads each base blob; a null (absent at
// ref) is skipped. A malformed BASE yields INVALID_DOMAIN_FILE and MUST NOT
// crash the gate into exit 2 (T-20-02) — domainReqsFromText never throws.
function collectBaseReqs(
  platformDir: string,
  ref: string,
  diagnostics: Diagnostic[],
): DomainReqSet {
  const reqs: SpecRequirement[] = [];
  const relPathById = new Map<string, string>();
  for (const path of gitLsTree(platformDir, ref, "spec-engine")) {
    if (!path.endsWith("/SPEC.json")) continue;
    // WR-03: enumerate the base under the SAME ignore rules the change side
    // (findDomainJsonFiles) applies, so a committed SPEC.json under an
    // ignored path (node_modules/, dist/, .spec-engine/, …) can't create an
    // asymmetric diff → spurious REQUIREMENT_REMOVED.
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

// Governance/propagation stage — the --base gate (20-03). Runs ONLY when `--base` is
// supplied. Every git/file read here sits BELOW `runIndex` (build_id is frozen
// the instant runIndex returns), so this stage can NEVER perturb build_id or
// the cold-rebuild byte-identity — GATE-04 by construction (temporal isolation,
// exactly like --results above). Without `--base`, git is never spawned and the
// diagnostic set is byte-identical to today's `spec check` (the flags are
// inert). The push is BEFORE renderDiagnostics so the formatter owns sort
// order, and the unchanged `severity === "error"` predicate flips the exit to 1
// on any REQUIREMENT_REMOVED / PARTIAL_PROPAGATION / strict
// UNAPPROVED_STATUS_FLIP.
async function runGovernanceGate(
  storage: Storage,
  platformDir: string,
  args: GovernanceArgs,
  diagnostics: Diagnostic[],
  results: IngestedResults,
): Promise<void> {
  if (!args.base) return;
  const ref = args.base;

  // CR-01 fail-CLOSED guard: gitShow/gitLsTree return null/[] for BOTH a
  // path absent at a valid ref (benign) AND an unresolvable ref / non-git
  // platformDir (fatal). Without this guard an unresolvable `--base`
  // (typo, unfetched `origin/main` on a shallow CI clone, non-git tree)
  // would leave baseReqs empty → every governance/propagation check
  // silently no-ops → the gate exits GREEN when it should be RED. A
  // "trusted-red" gate must never fail open, so refuse with exit 2 (usage
  // error, distinct from exit 1 = diagnostics) BEFORE any diffing.
  if (!gitRefResolves(platformDir, ref)) {
    console.error(
      `spec check: --base ref '${ref}' does not resolve in ${platformDir} ` +
        "(not a git repo, or the ref is unfetched/misspelled) — refusing to run the governance gate fail-open",
    );
    try {
      storage.close();
    } catch {
      // Already exiting 2 — ignore a close failure on a half-open DB.
    }
    process.exit(EXIT.USAGE);
  }

  const canonicalDir = join(platformDir, "spec-engine");
  const change = await collectChangeReqs(canonicalDir);
  const base = collectBaseReqs(platformDir, ref, diagnostics);

  // GUARD-010: a base id absent from the change with no approved supersession.
  diagnostics.push(
    ...requirementRemoved(base.reqs, change.reqs, (id) => base.relPathById.get(id) ?? null),
  );

  // GOV-02: a superseded/retired flip on a CODEOWNERS-owned path with no
  // approving domain owner. Two-tier severity (warning default / error
  // under --require-owner-approval). approvedBy is FAIL-CLOSED (empty = no
  // approver) and — per the T-20-04 trust boundary — MUST be sourced by CI
  // from the PR-reviews API, never from PR-author-controlled input.
  // @spec OWNER-001
  const codeowners = parseCodeowners(readCodeownersText(platformDir) ?? "");
  const approvedBy = (args.approvedBy ?? "")
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
      !!args.requireOwnerApproval,
    ),
  );

  // PROOF-007: a CHANGED active rule whose bound sites only PARTIALLY
  // re-proved green. Needs pass/fail evidence, so it fires ONLY when
  // --results is ALSO set — reusing the results + verifyingTags parsed in
  // the --results block above (no second read/parse).
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

// WR-05 crash handling: close storage if it was opened before the throw —
// otherwise the file handle would leak. Then surface exit 2 with the message on
// stderr so the CI gate can distinguish a crash from "5 expected diagnostics"
// (which is exit 1). A caught NotASpecPlatformError gets the friendly,
// actionable message instead of "crashed: <stack>", at the SAME exit code (2).
function exitAfterCrash(e: unknown, storage: Storage | undefined): never {
  try {
    storage?.close();
  } catch {
    // Closing a half-broken DB can itself throw; we are already
    // exiting 2 — swallow the secondary failure so the original
    // crash reason is what the user sees.
  }
  // Missing-canonical case → friendly, actionable message instead of
  // "crashed: <stack>". Same exit code (2) as the generic crash branch.
  if (e instanceof NotASpecPlatformError) {
    console.error(formatNotASpecPlatform(e.platformDir));
    process.exit(EXIT.USAGE);
  }
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`spec check: crashed: ${msg}`);
  process.exit(EXIT.USAGE);
}

export const checkCommand = defineCommand({
  meta: {
    name: "check",
    description:
      "Cross-repo integrity check. --ci rebuilds the index cold (rm db+wal+shm). Exits 1 on any error-severity diagnostic.",
  },
  args: {
    platformDir: {
      type: "positional",
      required: false,
      description: "Platform directory containing spec-engine/ + members (default: cwd)",
    },
    out: {
      type: "string",
      description: OUT_HELP,
    },
    ci: {
      type: "boolean",
      description: "Force cold rebuild: rm db+wal+shm BEFORE indexing (CHCK-01)",
    },
    json: {
      type: "boolean",
      description: "Emit diagnostics as a JSON array (no chrome, deterministically sorted)",
    },
    noPrompt: {
      type: "boolean",
      description:
        "Suppress interactive onboarding prompt for siblings missing spec-engine.member.json (defaults to NO_SPEC_CONFIG warning)",
    },
    unsourcedChange: {
      // USRC-02: opt-in. NO `default:` key — citty treats an absent boolean
      // as `undefined`, which the guard below reads as off. This is layer 1
      // of the two-layer off-by-default guarantee (layer 2 is the explicit
      // enabled-check guard in the run body). Emits the
      // warning-severity UNSOURCED_CHANGE diagnostic; OFF by default so the
      // 6-row inverted-CI baseline stays byte-identical without the flag.
      type: "boolean",
      description:
        "Opt-in: emit warning-severity UNSOURCED_CHANGE for Superseded requirements lacking a supersedes-via issue (OFF by default; USRC-02)",
    },
    results: {
      // GATE-01/GATE-02: opt-in trusted-red gate. NO `default:` key — citty
      // reads an absent string arg as `undefined`, which the post-index block
      // below treats as off. When supplied, the JUnit XML at this path is
      // resolved + containment-checked (mirroring --out), parsed, correlated
      // against verifying @spec tags, and any active requirement lacking a
      // passing correlated test surfaces an error-severity UNPROVEN_REQ (which
      // flips the exit to 1 through the unchanged severity predicate). Absent,
      // GATE-05 emits a PROOFS_UNCONFIRMED advisory (stderr in --json to keep
      // the byte-stable inverted-CI stdout baseline).
      type: "string",
      description: "Ingest a JUnit XML results file; enforce the trusted-red PROVEN gate (GATE-01)",
    },
    base: {
      // The --base opt-in governance/propagation gate. NO `default:` key — citty
      // reads an absent string arg as `undefined`, which the post-index block
      // below treats as off. When supplied, the PRIOR domain JSON is read from
      // this git ref (via `git show` / `git ls-tree` — base/gitBase.ts) and
      // diffed against the working tree: REQUIREMENT_REMOVED (GUARD-010),
      // UNAPPROVED_STATUS_FLIP (GOV-02), and PARTIAL_PROPAGATION (PROOF-007, when
      // --results is ALSO set) are appended AFTER runIndex so `build_id` is
      // never perturbed (GATE-04). Absent, git is never spawned and today's
      // `spec check` output is byte-preserved.
      type: "string",
      description:
        "Governance/propagation base ref (git). Reads prior domain JSON via git show/ls-tree to diff. Off when absent.",
    },
    approvedBy: {
      // GOV-02: comma-separated approver handles. FAIL-CLOSED — an empty/absent
      // value means NO approver, so every qualifying status flip fires. TRUST
      // BOUNDARY (T-20-04): CI MUST populate this from the trusted PR-reviews
      // API, NOT from PR-author-controlled input; git authorship is never used.
      type: "string",
      description:
        "Comma-separated approver handles for the status-flip gate (empty = fail-closed; CI must source from the trusted PR-reviews API, not PR-author input)",
    },
    requireOwnerApproval: {
      // GOV-02 two-tier: escalate UNAPPROVED_STATUS_FLIP from warning (default,
      // PR-annotation visibility) to error (fails the gate). NO `default:` key —
      // absent reads as `undefined` → warning tier.
      type: "boolean",
      description:
        "Escalate UNAPPROVED_STATUS_FLIP from warning to error (fails the gate on an unapproved status flip)",
    },
  },
  async run({ args }) {
    const platformDir = resolve((args.platformDir as string | undefined) ?? process.cwd());
    const outArg = args.out as string | undefined;
    // WR-01: resolve --out relative to platformDir (NOT cwd). Anchoring to
    // platformDir makes `spec check ../platform-fixture --out custom.sqlite`
    // behave the way users expect — DB inside the platform tree — without
    // tripping the V12 containment guard for an obviously-safe input.
    // Absolute paths still resolve as absolute; only relative paths shift.
    const dbPath = resolveDbPath(platformDir, outArg);

    // V12 path-containment: --out must resolve under platformDir. Defense
    // against `--ci --out ../../etc/passwd` and friends.
    if (outArg) assertContainedPath(dbPath, platformDir, "spec check: --out");

    // INIT-13 pre-flight: interactive prompt for skipped siblings. Runs
    // BEFORE mkdirSync(.spec-engine) so the exit-1 n-path leaves no artefacts.
    // Suppressed in non-TTY / --ci / --no-prompt contexts; falls through
    // to NO_SPEC_CONFIG warning per Phase 8 in those cases.
    await maybePromptForOnboarding({
      platformDir,
      args: {
        ci: args.ci as boolean | undefined,
        noPrompt: args.noPrompt as boolean | undefined,
      },
    });

    // WR-05: open storage and run the pipeline under a try/catch so any
    // crash inside openStorage / runIndex / collectDiagnostics /
    // renderDiagnostics surfaces as exit code 2 ("command crash"), not as
    // citty's default uncaught-exception handling (which maps to exit 1 —
    // colliding with the "any error-severity diagnostic" exit code that
    // the inverted CI assertion depends on). The path-containment guard
    // above already exits 2 BEFORE we get here, so its semantics are
    // preserved untouched.
    let storage: ReturnType<typeof openStorage> | undefined;
    let failing = false;
    try {
      // Pre-flight: a non-platform dir throws BEFORE mkdirSync/--ci rm/
      // openStorage, so the not-a-platform case leaves NO .spec-engine/ artifact
      // and stays idempotent across runs (no stale empty index can poison a
      // later invocation). CLAUDE.md: the derived DB owns nothing — a failed
      // build leaves no artifact.
      assertSpecPlatform(platformDir);

      mkdirSync(dirname(dbPath), { recursive: true });

      // --ci: cold-reset the derived DB BEFORE openStorage — an IN-PLACE
      // wipe (coldResetDb), not an unlink, so a long-lived `spec serve`
      // reader on the same file keeps its inode and sees the fresh
      // derivation instead of ghosting onto deleted data. Freshness is
      // identical to the old rm-trio: every user object is dropped and
      // openStorage re-runs the full DDL (ci.yml smoke 6 still proves
      // cold-rebuild build_id equivalence).
      if (args.ci) {
        coldResetDb(dbPath);
        // Log to stderr so --json stdout stays clean (CI smoke parses
        // stdout with JSON.parse; any chrome there would break the
        // inverted assertion).
        console.error("spec check --ci: cold-reset prior index state (in place)");
      }

      storage = openStorage(dbPath);
      const result = await runIndex({ platformDir, storage });
      const diagnostics = collectDiagnostics(storage);

      // Layer 2 of off-by-default (USRC-02): the emission is gated behind an
      // explicit enabled-check. Only when `--unsourced-change` is passed do we
      // read the Superseded requirements + provenance (through the Storage
      // interface — no SQLite runtime, D-08) and concat the warning rows into
      // diagnostics array BEFORE render, so renderDiagnostics owns their sort
      // order. The append composes with the unchanged `severity === "error"`
      // exit predicate below — a warning-only addition never flips the exit
      // code (USRC-03). The read happens AFTER runIndex (and --ci rm's the DB
      // first), so it is always against a freshly-rebuilt index.
      if (args.unsourcedChange) {
        const superseded = storage.listRequirements({ status: "Superseded" });
        const provenance = storage.listProvenance();
        diagnostics.push(...unsourcedChanges(superseded, provenance));
      }

      // Results-ingest stage (GATE-01/02/05): reads/parses --results under the
      // T-19-04 containment guard and hoists the parsed results + verifying
      // tags for the governance stage's PROOF-007 reuse. Every read stays AFTER
      // runIndex, so build_id is never perturbed (GATE-04 temporal isolation).
      const results = await ingestResults(
        storage,
        platformDir,
        args.results as string | undefined,
        !!args.json,
        diagnostics,
      );

      // Governance/propagation stage (GUARD-010, GOV-02, CR-01, PROOF-007): the entire
      // --base block. Inert without --base; every git read stays AFTER runIndex
      // (GATE-04 temporal isolation, exactly like --results above).
      await runGovernanceGate(
        storage,
        platformDir,
        {
          base: args.base as string | undefined,
          approvedBy: args.approvedBy as string | undefined,
          requireOwnerApproval: args.requireOwnerApproval as boolean | undefined,
        },
        diagnostics,
        results,
      );

      const output = renderDiagnostics(diagnostics, args.json ? "json" : "text");
      console.log(output);

      // Non-JSON mode includes a trailing build_id line so the human
      // reader can see what they're looking at. JSON mode emits ONLY
      // the diagnostic array (03-RESEARCH § Open Question 2) so the
      // inverted CI assertion gets byte-stable output.
      if (!args.json) {
        console.log(`build_id: ${result.build_id}`);
      }

      failing = diagnostics.some((d) => d.severity === "error");
    } catch (e) {
      exitAfterCrash(e, storage);
    }
    // Close storage BEFORE process.exit so the DB file handle releases
    // cleanly. Bun's process.exit terminates synchronously and skips
    // pending finally blocks, so we cannot rely on the finally-after-
    // exit ordering pattern.
    storage.close();
    // Exit AFTER close: 1 on any error-severity diagnostic, 0 otherwise.
    process.exit(failing ? EXIT.FAILURE : EXIT.OK);
  },
});
