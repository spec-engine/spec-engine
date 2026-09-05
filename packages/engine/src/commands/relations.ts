// packages/engine/src/commands/relations.ts
//
// `spec relations [platformDir] [--out <path>] [--json] [--fresh]`: the
// `relates` graph as mermaid `graph LR` source, or the sorted rows under
// `--json`. Read-only; the same formatter serves `/api/relations?format=mermaid`.

import { defineCommand } from "citty";
import { OUT_HELP, resolveDbPath } from "../constants";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { relations } from "../operations/reads";
import { renderRelations } from "../relations/format";
import { platformDirArg, resolvePlatformDir } from "./_args";
import { assertContainedPath, withReadStorage } from "./_shared";

/** An indexed platform with no `relates` links is a legitimate empty graph, not an error. */
function formatNoRelations(platformDir: string): string {
  return [
    `No Relates links indexed under ${platformDir}.`,
    `Link requirements with a "**Relates:** KEY-NNN" line in spec-engine/<KEY>/SPEC.md, then re-run \`spec index\`.`,
  ].join("\n");
}

export const relationsCommand = defineCommand({
  meta: {
    name: "relations",
    description:
      "Render the Relates links between requirements as a mermaid entity diagram. --json emits the sorted relation rows.",
  },
  args: {
    platformDir: platformDirArg,
    out: {
      type: "string",
      description: OUT_HELP,
    },
    json: {
      type: "boolean",
      description: "Emit relation rows as a JSON array (deterministically sorted, no chrome)",
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
    const outArg = args.out as string | undefined;
    const dbPath = resolveDbPath(platformDir, outArg);
    if (outArg) assertContainedPath(dbPath, platformDir, "spec relations: --out");

    await maybePromptForOnboarding({
      platformDir,
      args: {
        noPrompt: args.noPrompt as boolean | undefined,
      },
    });

    await withReadStorage({ platformDir, dbPath, fresh: !!args.fresh }, (storage) => {
      const { rows } = relations(storage);
      if (!args.json && rows.length === 0) {
        console.error(formatNoRelations(platformDir));
        return;
      }
      const output = renderRelations(rows, args.json ? "json" : "mermaid");
      console.log(output);
    });
  },
});
