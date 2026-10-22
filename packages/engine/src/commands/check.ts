// @spec CHCK-012
// @spec CHCK-043
// @spec CHCK-014
// @spec CHCK-025

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
import { exit } from "../stdout";
import { jsonArg, noPromptArg, outArg, platformDirArg, resolvePlatformDir } from "./_args";
import { assertContainedPath, handleInvalidDomainFiles } from "./_shared";

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
      description: "Force cold rebuild: rm db+wal+shm BEFORE indexing",
    },
    json: jsonArg,
    noPrompt: noPromptArg,
    unsourcedChange: {
      type: "boolean",
      description:
        "Opt-in: emit warning-severity UNSOURCED_CHANGE for Superseded requirements lacking a supersedes-via issue (OFF by default)",
    },
    results: {
      type: "string",
      description: "Ingest a JUnit XML results file; enforce the trusted-red PROVEN gate",
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
    const outArgValue = args.out;
    const dbPath = resolveDbPath(platformDir, outArgValue);
    if (outArgValue) assertContainedPath(dbPath, platformDir, "spec check: --out");

    await maybePromptForOnboarding({
      platformDir,
      args: {
        ci: args.ci,
        noPrompt: args.noPrompt,
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
          const resultsPath = resolveResultsPath(platformDir, args.results);
          const result = await check(
            {
              platformDir,
              resultsPath,
              base: args.base,
              approvedBy: args.approvedBy,
              requireOwnerApproval: args.requireOwnerApproval,
              unsourcedChange: args.unsourcedChange,
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
      await handleInvalidDomainFiles(e, jsonMode);
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
    await exit(outcome.failing ? EXIT.FAILURE : EXIT.OK);
  },
});

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

function exitAfterCrash(e: unknown): never {
  if (e instanceof NotASpecPlatformError) {
    console.error(formatNotASpecPlatform(e.platformDir));
    process.exit(EXIT.USAGE);
  }
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`spec check: crashed: ${msg}`);
  process.exit(EXIT.USAGE);
}
