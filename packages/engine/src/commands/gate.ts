// packages/engine/src/commands/gate.ts
//
// `spec gate <repo> <reqId> [platformDir]`: the approval gate. The command
// validates the positionals, cold-resets the index, and renders the outcome;
// the decision lives in operations/gate.ts. Exit 0 PASS, 1 any gate failure,
// 2 bad args, unknown repo, path-containment violation, or a crash.
//
// Bun's `process.exit` skips pending `finally` blocks, so every exit here
// happens after `withIndex` has closed the storage handle.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineCommand, type ParsedArgs } from "citty";
import { EXIT, OUT_HELP, resolveDbPath } from "../constants";
import { renderGate } from "../gate/format";
import { formatNotASpecPlatform } from "../indexer/discover";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { withIndex } from "../operations/_index";
import { type GateResult, gate } from "../operations/gate";
import { platformDirArg, resolvePlatformDir } from "./_args";
import { assertContainedPath } from "./_shared";

/** A closed read end on a pipe (`spec gate … | head -1`) is the consumer's choice, not a crash. */
function isEpipe(e: unknown): boolean {
  if (e === null || typeof e !== "object" || !("code" in e)) return false;
  const code = e.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

function writeStdoutTolerant(line: string): void {
  try {
    console.log(line);
  } catch (writeErr) {
    if (!isEpipe(writeErr)) throw writeErr;
  }
}

interface GateTarget {
  repo: string;
  reqId: string;
  platformDir: string;
}

/** Trimmed, non-empty positionals and a platform dir, or exit 2 before any filesystem write. */
function resolveGateArgs(args: GateArgs): GateTarget {
  const repo = (args.repo ?? "").trim();
  const reqId = (args.reqId ?? "").trim();
  if (!repo || !reqId) {
    console.error("spec gate: <repo> and <reqId> are required (e.g., spec gate api BILLING-009)");
    process.exit(EXIT.USAGE);
  }
  const platformDir = resolvePlatformDir(args);
  if (!existsSync(join(platformDir, "spec-engine"))) {
    console.error(formatNotASpecPlatform(platformDir));
    process.exit(EXIT.USAGE);
  }
  return { repo, reqId, platformDir };
}

const gateArgs = {
  repo: {
    type: "positional",
    required: true,
    description: "Member repo name (e.g., api, mobile, admin)",
  },
  reqId: {
    type: "positional",
    required: true,
    description: "Target requirement id (e.g., BILLING-009)",
  },
  platformDir: platformDirArg,
  out: {
    type: "string",
    description: OUT_HELP,
  },
  json: {
    type: "boolean",
    description: "Emit outcome as a JSON object (no chrome, byte-stable)",
  },
  noPrompt: {
    type: "boolean",
    description:
      "Suppress interactive onboarding prompt for siblings missing spec-engine.member.json (defaults to NO_SPEC_CONFIG warning)",
  },
} as const;

type GateArgs = ParsedArgs<typeof gateArgs>;

export const gateCommand = defineCommand({
  meta: {
    name: "gate",
    description:
      "Rung-3 approval primitive: passes iff <reqId> is Active and <repo>'s pinned spec_version covers its changed_at_version. Exits 0 PASS / 1 any gate failure / 2 crash or bad args.",
  },
  args: gateArgs,
  async run({ args }) {
    const { repo, reqId, platformDir } = resolveGateArgs(args);
    const outArg = args.out;
    const dbPath = resolveDbPath(platformDir, outArg);
    if (outArg) assertContainedPath(dbPath, platformDir, "spec gate: --out");

    await maybePromptForOnboarding({
      platformDir,
      args: { noPrompt: args.noPrompt },
    });

    let gated: GateResult | undefined;
    try {
      gated = await withIndex({ platformDir, dbPath, build: "reset" }, async (h) => {
        console.error("spec gate: cold-reset prior index state (in place)");
        const r = await gate({ platformDir, repo, reqId }, h.storage);
        if (!r.ok) {
          console.error(`spec gate: ${r.detail}`);
          return undefined;
        }
        return r;
      });
      if (gated !== undefined) {
        writeStdoutTolerant(renderGate(gated.outcome, args.json ? "json" : "text"));
        if (!args.json) writeStdoutTolerant(`build_id: ${gated.buildId}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`spec gate: crashed: ${msg}`);
      process.exit(EXIT.USAGE);
      return;
    }
    if (gated === undefined) {
      process.exit(EXIT.USAGE);
      return;
    }
    process.exit(gated.outcome.pass ? EXIT.OK : EXIT.FAILURE);
  },
});
