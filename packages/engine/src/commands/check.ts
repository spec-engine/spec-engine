// packages/engine/src/commands/check.ts
//
// @spec CHCK-012
// @spec CHCK-013
// @spec CHCK-014
// @spec CHCK-025
//
// `spec check [platformDir] [--out <path>] [--ci] [--json]`: the integrity
// gate. Exit 0 clean, 1 on any error-severity diagnostic, 2 on a crash, bad
// args, or a path-containment violation.

import { resolve } from "node:path";
import { NotASpecPlatformError } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { renderDiagnostics } from "../check/format";
import { proofsUnconfirmedWarning } from "../check/proven";
import { EXIT, isContainedPath, resolveDbPath } from "../constants";
import { formatNotASpecPlatform } from "../indexer/discover";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { withIndex } from "../operations/_index";
import { type CheckResult, check } from "../operations/check";
import { jsonArg, noPromptArg, outArg, platformDirArg, resolvePlatformDir } from "./_args";
import { assertContainedPath } from "./_shared";

export const checkCommand = defineCommand({
  meta: {
    name: "check",
    description:
      "Cross-repo integrity check. --ci rebuilds the index cold (rm db+wal+shm). Exits 1 on any error-severity diagnostic.",
  },
  args: {
    platformDir: platformDirArg,
    out: outArg,
    ci: {
      type: "boolean",
      description: "Force cold rebuild: rm db+wal+shm BEFORE indexing (CHCK-01)",
    },
    json: jsonArg,
    noPrompt: noPromptArg,
    unsourcedChange: {
      type: "boolean",
      description:
        "Opt-in: emit warning-severity UNSOURCED_CHANGE for Superseded requirements lacking a supersedes-via issue (OFF by default; USRC-02)",
    },
    results: {
      type: "string",
      description: "Ingest a JUnit XML results file; enforce the trusted-red PROVEN gate (GATE-01)",
    },
    base: {
      type: "string",
      description:
        "Governance/propagation base ref (git). Reads prior domain JSON via git show/ls-tree to diff. Off when absent.",
    },
    approvedBy: {
      type: "string",
      description:
        "Comma-separated approver handles for the status-flip gate (empty = fail-closed; CI must source from the trusted PR-reviews API, not PR-author input)",
    },
    requireOwnerApproval: {
      type: "boolean",
      description:
        "Escalate UNAPPROVED_STATUS_FLIP from warning to error (fails the gate on an unapproved status flip)",
    },
  },
  async run({ args }) {
    const platformDir = resolvePlatformDir(args);
    const outArgValue = args.out as string | undefined;
    const dbPath = resolveDbPath(platformDir, outArgValue);
    if (outArgValue) assertContainedPath(dbPath, platformDir, "spec check: --out");

    await maybePromptForOnboarding({
      platformDir,
      args: {
        ci: args.ci as boolean | undefined,
        noPrompt: args.noPrompt as boolean | undefined,
      },
    });

    const jsonMode = Boolean(args.json);
    let outcome: CheckResult | undefined;
    try {
      outcome = await withIndex(
        { platformDir, dbPath, build: args.ci ? "reset" : "never" },
        async (h) => {
          if (args.ci) {
            console.error("spec check --ci: cold-reset prior index state (in place)");
          }
          const resultsPath = resolveResultsPath(platformDir, args.results as string | undefined);
          const result = await check(
            {
              platformDir,
              resultsPath,
              base: args.base as string | undefined,
              approvedBy: args.approvedBy as string | undefined,
              requireOwnerApproval: args.requireOwnerApproval as boolean | undefined,
              unsourcedChange: args.unsourcedChange as boolean | undefined,
            },
            h.storage,
          );
          if (!result.ok) {
            console.error(`spec check: ${result.detail}`);
            return undefined;
          }
          return result;
        },
      );
    } catch (e) {
      exitAfterCrash(e);
    }
    if (outcome === undefined) {
      process.exit(EXIT.USAGE);
      return;
    }

    const diagnostics = [...outcome.diagnostics];
    if (outcome.proofsUnconfirmed) {
      if (jsonMode) {
        console.error(
          "spec check: no --results supplied; proofs unconfirmed (PROOFS_UNCONFIRMED) — run with --results <junit.xml> to enforce trusted-red",
        );
      } else {
        diagnostics.push(proofsUnconfirmedWarning());
      }
    }
    console.log(renderDiagnostics(diagnostics, jsonMode ? "json" : "text"));
    if (!jsonMode) console.log(`build_id: ${outcome.buildId}`);
    process.exit(outcome.failing ? EXIT.FAILURE : EXIT.OK);
  },
});

/** `--results` resolves against platformDir and must stay inside it. Exits 2 otherwise. */
function resolveResultsPath(
  platformDir: string,
  resultsArg: string | undefined,
): string | undefined {
  if (!resultsArg) return undefined;
  const resultsPath = resolve(platformDir, resultsArg);
  if (!isContainedPath(resultsPath, platformDir)) {
    console.error(
      `spec check: --results path must be inside platformDir (resolved to ${resultsPath})`,
    );
    process.exit(EXIT.USAGE);
  }
  return resultsPath;
}

/** A crash is exit 2 with the reason; a non-platform directory gets the friendly message. */
function exitAfterCrash(e: unknown): never {
  if (e instanceof NotASpecPlatformError) {
    console.error(formatNotASpecPlatform(e.platformDir));
    process.exit(EXIT.USAGE);
  }
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`spec check: crashed: ${msg}`);
  process.exit(EXIT.USAGE);
}
