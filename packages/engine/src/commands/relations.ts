// packages/engine/src/commands/relations.ts
//
// RED-17: `spec relations [platformDir] [--out <path>] [--json]` — citty
// subcommand that renders the Relates entity diagram as mermaid `graph LR`
// source (paste into any mermaid renderer / GitHub markdown). `--json`
// emits the deterministically sorted RelationRow[] instead.
//
// Behavior mirrors commands/map.ts (read-only command conventions):
//   - Never exits non-zero on the data itself. Bad args or
//     path-containment violations exit 2.
//   - If `dbPath` does not exist (or the index is empty — D-12
//     silent-rebuild case), transparently runIndex.
//   - Output is delegated to relations/format.ts (pure formatter) — the
//     SAME formatter `/api/relations?format=mermaid` serves, so the CLI
//     and webapp surfaces cannot drift (one engine, not two).
//
// V12 path-containment: `--out` must resolve under platformDir — same
// guard as commands/check.ts / commands/map.ts.
//
// D-08 grep-fence: this file does NOT import bun:sqlite. DB access goes
// exclusively through the Storage interface from @spec-engine/shared.

import { resolve } from "node:path";
import { defineCommand } from "citty";
import { OUT_HELP, resolveDbPath } from "../constants";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { renderRelations } from "../relations/format";
import { assertContainedPath, withReadStorage } from "./_shared";

/** B.1-style empty-state message (stderr, exit 0) — relations-specific:
 *  an indexed platform with requirements but no `**Relates:** …` fields
 *  is a legitimate empty graph, not an error. */
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
    const platformDir = resolve((args.platformDir as string | undefined) ?? process.cwd());
    const outArg = args.out as string | undefined;
    // WR-01: resolve --out relative to platformDir (NOT cwd) — mirrors
    // commands/check.ts. See check.ts for full rationale.
    const dbPath = resolveDbPath(platformDir, outArg);

    // V12 path-containment guard — mirrors commands/map.ts.
    if (outArg) assertContainedPath(dbPath, platformDir, "spec relations: --out");

    // INIT-13 pre-flight: interactive prompt for skipped siblings —
    // mirrors commands/map.ts.
    await maybePromptForOnboarding({
      platformDir,
      args: {
        noPrompt: args.noPrompt as boolean | undefined,
      },
    });

    await withReadStorage({ platformDir, dbPath, fresh: !!args.fresh }, (storage) => {
      const rows = storage.listRelations();
      // Empty graph in text mode → actionable stderr message, exit 0
      // (read-only command; empty data is not an error). JSON mode stays
      // machine-clean: "[]" on stdout, no message.
      if (!args.json && rows.length === 0) {
        console.error(formatNoRelations(platformDir));
        return;
      }
      const output = renderRelations(rows, args.json ? "json" : "mermaid");
      console.log(output);
    });
    // Read-only command: exit 0 unconditionally on success.
  },
});
