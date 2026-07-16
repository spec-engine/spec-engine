// packages/engine/src/commands/index.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INDX-003
//
// `spec index [platformDir] [--out <path>] [--json]` — citty subcommand
// wrapping the runIndex pipeline (INDX-01..04 wired through PARS-05).
//
// Defaults:
//   - platformDir → process.cwd()
//   - --out       → <platformDir>/.spec-engine/index.sqlite
//   - --json      → false (human-readable summary)
//
// JSON mode emits exactly the IndexResult shape so CI can parse it via jq /
// bun -e and assert build_id equivalence (CI-02 — smoke 6 in ci.yml).
//
// HARD CONSTRAINT (D-08): this file does NOT import bun:sqlite directly.
// Storage construction goes through `openStorage` (the only file in the
// repo allowed to touch bun:sqlite). The Rust-swap seam stays clean.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { NotASpecPlatformError } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { EXIT, OUT_HELP, resolveDbPath } from "../constants";
import { assertSpecPlatform, formatNotASpecPlatform } from "../indexer/discover";
import { runIndex } from "../indexer/pipeline";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { openStorage } from "../storage/sqlite";
import { assertContainedPath } from "./_shared";

export const indexCommand = defineCommand({
  meta: {
    name: "index",
    description:
      "Index a platform directory, writing the derived SQLite index to .spec-engine/index.sqlite (or --out)",
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
      description: "Emit the IndexResult as JSON to stdout (CI / scripting)",
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
    // RED-14 parity fix: index was the only --out-bearing command that
    // resolved --out relative to CWD and skipped the V12 containment
    // guard. Mirror commands/check.ts WR-01 (resolve relative to
    // platformDir) + the containment check used by map/query/propagation/
    // gate/serve so a hostile or accidental `--out ../../x.sqlite` cannot
    // write outside the platform tree.
    const dbPath = resolveDbPath(platformDir, outArg);
    if (outArg) assertContainedPath(dbPath, platformDir, "spec index: --out");

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

    // Hoisted so the catch/finally can close it if openStorage succeeded.
    let storage: ReturnType<typeof openStorage> | undefined;
    try {
      // Pre-flight: a non-platform dir throws BEFORE mkdirSync/openStorage,
      // so the not-a-platform case leaves NO .spec-engine/ artifact and stays
      // idempotent across runs. CLAUDE.md: the derived DB owns nothing — a
      // failed build leaves no artifact.
      assertSpecPlatform(platformDir);

      mkdirSync(dirname(dbPath), { recursive: true });

      storage = openStorage(dbPath);
      const result = await runIndex({ platformDir, storage });
      if (args.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log("spec index OK");
        console.log(`  build_id:     ${result.build_id}`);
        console.log(`  repos:        ${result.repos}`);
        console.log(`  domains:      ${result.domains}`);
        console.log(`  requirements: ${result.requirements}`);
        console.log(`  tags:         ${result.tags}`);
        console.log(`  diagnostics:  ${result.diagnostics}`);
      }
    } catch (err) {
      // Missing-canonical case → friendly, actionable message + exit 2
      // (usage-style, aligned with map/check). Genuine indexing crashes
      // (malformed config, Zod, hashing) keep the FAILED-exit-1 behavior.
      if (err instanceof NotASpecPlatformError) {
        console.error(formatNotASpecPlatform(err.platformDir));
        process.exit(EXIT.USAGE);
      }
      console.error("spec index FAILED:", err);
      process.exit(EXIT.FAILURE);
    } finally {
      storage?.close();
    }
  },
});
