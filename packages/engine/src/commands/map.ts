// packages/engine/src/commands/map.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec MAP-001
//
// `spec map [platformDir] [--out <path>] [--json]` — citty subcommand
// that renders the cross-repo coverage matrix directly from the `coverage`
// SQL VIEW (MAP-01) with deterministic ordering (MAP-02).
//
// Behavior:
//   - Read-only command: never exits non-zero on the data itself (no
//     diagnostic semantics). Bad args or path-containment violations exit 2.
//   - If `dbPath` does not exist, transparently runIndex (03-RESEARCH
//     Open Q1 — same resolution as `spec check`). If it already exists,
//     reuse it; the user is expected to `spec index` themselves to
//     refresh, or pipe `spec check --ci` first for CI cold-rebuild.
//   - Output is delegated to map/format.ts (pure formatter). Text mode is
//     a column-per-repo table; JSON mode is JSON.stringify(sorted) for
//     byte-stable downstream consumption.
//
// V12 path-containment: if `--out` is supplied, the resolved path MUST
// stay under `resolve(platformDir)`. Same guard as commands/check.ts.
//
// D-08 grep-fence: this file does NOT import bun:sqlite. DB access goes
// exclusively through the Storage interface from @spec-engine/shared.

import { resolve } from "node:path";
import { defineCommand } from "citty";
import { OUT_HELP, resolveDbPath } from "../constants";
import { formatNoRequirementsIndexed } from "../indexer/discover";
import { renderMatrix } from "../map/format";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { assertContainedPath, withReadStorage } from "./_shared";

export const mapCommand = defineCommand({
  meta: {
    name: "map",
    description:
      "Render the cross-repo coverage matrix from the coverage VIEW. --json emits a deterministically sorted JSON array.",
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
    const platformDir = resolve((args.platformDir as string | undefined) ?? process.cwd());
    const outArg = args.out as string | undefined;
    // WR-01: resolve --out relative to platformDir (NOT cwd) — mirrors
    // commands/check.ts. See check.ts for full rationale.
    const dbPath = resolveDbPath(platformDir, outArg);

    // V12 path-containment guard — mirrors commands/check.ts.
    if (outArg) assertContainedPath(dbPath, platformDir, "spec map: --out");

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
      const rows = storage.coverageMatrix();
      // B.1: an indexed-but-empty platform would otherwise print a blank
      // line in text mode (renderMatrix([], "text") === "" by contract).
      // Replace that silent blank with an actionable message on stderr,
      // still exiting 0 (map is read-only; empty data is not an error).
      // JSON mode is untouched — machine consumers depend on "[]" on stdout.
      if (!args.json && rows.length === 0) {
        console.error(formatNoRequirementsIndexed(platformDir));
        return;
      }
      console.log(renderMatrix(rows, args.json ? "json" : "text"));
    });
    // Read-only command: exit 0 unconditionally on success.
  },
});
