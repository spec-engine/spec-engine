// packages/engine/src/commands/map.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec MAP-002
//
// `spec map [platformDir] [--out <path>] [--json] [--fresh]`: the
// requirement-by-repo coverage matrix. Read-only: the data never drives a
// non-zero exit; bad args and a `--out` outside the platform exit 2.

import { defineCommand } from "citty";
import { OUT_HELP, resolveDbPath } from "../constants";
import { formatNoRequirementsIndexed } from "../indexer/discover";
import { renderMatrix } from "../map/format";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { coverageMatrix } from "../operations/reads";
import { platformDirArg, resolvePlatformDir } from "./_args";
import { assertContainedPath, withReadStorage } from "./_shared";

export const mapCommand = defineCommand({
  meta: {
    name: "map",
    description:
      "Render the cross-repo coverage matrix from the coverage VIEW. --json emits a deterministically sorted JSON array.",
  },
  args: {
    platformDir: platformDirArg,
    out: {
      type: "string",
      description: OUT_HELP,
    },
    json: {
      type: "boolean",
      description: "Emit coverage rows as a JSON array (deterministically sorted, no chrome)",
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
    const platformDir = resolvePlatformDir(args);
    const outArg = args.out;
    const dbPath = resolveDbPath(platformDir, outArg);
    if (outArg) assertContainedPath(dbPath, platformDir, "spec map: --out");

    await maybePromptForOnboarding({
      platformDir,
      args: {
        noPrompt: args.noPrompt,
      },
    });

    await withReadStorage({ platformDir, dbPath, fresh: !!args.fresh }, (storage) => {
      const { rows } = coverageMatrix(storage);
      if (!args.json && rows.length === 0) {
        console.error(formatNoRequirementsIndexed(platformDir));
        return;
      }
      console.log(renderMatrix(rows, args.json ? "json" : "text"));
    });
  },
});
