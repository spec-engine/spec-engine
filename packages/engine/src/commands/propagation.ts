// packages/engine/src/commands/propagation.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec PROP-003
//
// `spec propagation <reqId> [platformDir] [--out <path>] [--json]` — citty
// subcommand that classifies each member repo's relationship to a target
// requirement using the 5-state PROP_REPO_STATES_SQL machine (PROP-01 /
// PROP-03). Reads exclusively through `storage.propagationFor(reqId)` —
// which itself overlays the drift set from `storage.listDriftRows()` —
// so the drift predicate is never redefined here (PROP-01).
//
// Behavior:
//   - Read-only command: never exits non-zero on data shape. Bad args or
//     path-containment violations exit 2. Successful execution lets citty
//     fall through to exit 0 (matches commands/map.ts).
//   - Missing reqId (empty or whitespace-only): stderr usage message,
//     exit 2.
//   - If `dbPath` does not exist, transparently runIndex (03-RESEARCH
//     Open Q1 — same resolution as `spec check` / `spec map`). If it
//     already exists, reuse it.
//   - Output delegated to propagation/format.ts (pure formatter). Text
//     mode is REPO | STATE | VIA | DRIFT?; JSON mode is
//     JSON.stringify(sorted) for byte-stable downstream consumption.
//
// Five-state classification (PROP-03):
//   MIGRATED_VERIFIED      — member tags target with implements + verifies
//   MIGRATED_UNVERIFIED    — member tags target with implements only
//   ON_PREDECESSOR         — member is pinned to a predecessor of target
//   ON_OTHER_DOMAIN_REQ    — member tags a different req in target's domain
//   NO_DOMAIN_REFERENCE    — member has no tag in target's domain at all
//
// V12 path-containment: if `--out` is supplied, the resolved path MUST
// stay under `resolve(platformDir)`. Same guard as commands/check.ts and
// commands/map.ts.
//
// D-08 grep-fence: this file does NOT import bun:sqlite. DB access goes
// exclusively through the Storage interface from @spec-engine/shared.

import { resolve } from "node:path";
import { defineCommand } from "citty";
import { EXIT, OUT_HELP, resolveDbPath } from "../constants";
import { formatNoRequirementsIndexed } from "../indexer/discover";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { renderPropagation } from "../propagation/format";
import { assertContainedPath, withReadStorage } from "./_shared";

export const propagationCommand = defineCommand({
  meta: {
    name: "propagation",
    description:
      "Classify each member repo's relationship to a target requirement (PROP-01). States: MIGRATED_VERIFIED, MIGRATED_UNVERIFIED, ON_PREDECESSOR, ON_OTHER_DOMAIN_REQ, NO_DOMAIN_REFERENCE.",
  },
  args: {
    reqId: {
      type: "positional",
      required: true,
      description: "Target requirement id, e.g., BILLING-009",
    },
    platformDir: {
      type: "positional",
      required: false,
      description: "Platform directory containing spec-engine/ + members (default: cwd)",
    },
    out: {
      type: "string",
      description: OUT_HELP,
    },
    json: {
      type: "boolean",
      description: "Emit rows as JSON (deterministically sorted, no chrome)",
    },
    fresh: {
      type: "boolean",
      description:
        "Force a cold rebuild of the derived index before reading (rm + reindex; same trio as check --ci)",
    },
    noPrompt: {
      type: "boolean",
      description:
        "Suppress interactive onboarding prompt for siblings missing spec-engine.member.json (defaults to NO_SPEC_CONFIG warning)",
    },
  },
  async run({ args }) {
    const reqId = ((args.reqId as string | undefined) ?? "").trim();
    if (!reqId) {
      console.error("spec propagation: <reqId> is required (e.g., spec propagation BILLING-009)");
      process.exit(EXIT.USAGE);
      return;
    }

    const platformDir = resolve((args.platformDir as string | undefined) ?? process.cwd());
    const outArg = args.out as string | undefined;
    // WR-01: resolve --out relative to platformDir (NOT cwd) — mirrors
    // commands/check.ts and commands/map.ts.
    const dbPath = resolveDbPath(platformDir, outArg);

    // V12 path-containment guard — mirrors commands/map.ts.
    if (outArg) assertContainedPath(dbPath, platformDir, "spec propagation: --out");

    // INIT-13 pre-flight: interactive prompt for skipped siblings. Runs
    // BEFORE mkdirSync(.spec-engine) so the exit-1 n-path leaves no artefacts.
    // Suppressed in non-TTY / --no-prompt contexts; falls through
    // to NO_SPEC_CONFIG warning per Phase 8 in those cases.
    // WR-01: only `check` registers `--ci`, so `args.ci` would be undefined
    // here — drop the dead plumbing rather than forward `undefined`.
    await maybePromptForOnboarding({
      platformDir,
      args: {
        noPrompt: args.noPrompt as boolean | undefined,
      },
    });

    await withReadStorage({ platformDir, dbPath, fresh: !!args.fresh }, (storage) => {
      const rows = storage.propagationFor(reqId);
      // RED-11: distinguish "no member rows for this reqId" (a normal
      // empty result) from "this platform has no requirements at all" (a
      // brand-new platform that deserves first-spec guidance). Text mode
      // only — JSON consumers depend on "[]" on stdout. Still exit 0.
      if (!args.json && rows.length === 0 && storage.listRequirements().length === 0) {
        console.error(formatNoRequirementsIndexed(platformDir));
        return;
      }
      const output = renderPropagation(rows, args.json ? "json" : "text");
      console.log(output);
    });
    // Read-only command: exit 0 unconditionally on success.
  },
});
