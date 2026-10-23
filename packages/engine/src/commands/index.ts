// @spec INDX-023

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { NotASpecPlatformError } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { EXIT, OUT_HELP, resolveDbPath } from "../constants";
import { assertSpecPlatform, formatNotASpecPlatform } from "../indexer/discover";
import { runIndex } from "../indexer/pipeline";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { openStorage } from "../storage/sqlite";
import { platformDirArg, resolvePlatformDir } from "./_args";
import { assertContainedPath, handleInvalidDomainFiles } from "./_shared";

export const indexCommand = defineCommand({
  meta: {
    name: "index",
    description:
      "Index a platform directory, writing the derived SQLite index to .spec-engine/index.sqlite (or --out)",
  },
  args: {
    platformDir: platformDirArg,
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
    const platformDir = resolvePlatformDir(args);
    const outArg = args.out;
    // --out resolves against platformDir, not cwd, and must stay inside it,
    // so `--out ../../x.sqlite` cannot write outside the platform tree.
    const dbPath = resolveDbPath(platformDir, outArg);
    if (outArg) assertContainedPath(dbPath, platformDir, "spec index: --out");

    // Runs before mkdirSync(.spec-engine) so declining the prompt leaves no
    // artefacts. No `ci` arg: only `check` registers `--ci`.
    await maybePromptForOnboarding({
      platformDir,
      args: {
        noPrompt: args.noPrompt,
      },
    });

    let storage: ReturnType<typeof openStorage> | undefined;
    try {
      // Must throw before mkdirSync/openStorage so a non-platform dir is left
      // with no .spec-engine/ artifact.
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
      if (err instanceof NotASpecPlatformError) {
        console.error(formatNotASpecPlatform(err.platformDir));
        process.exit(EXIT.USAGE);
      }
      await handleInvalidDomainFiles(err, !!args.json);
      console.error("spec index FAILED:", err);
      process.exit(EXIT.FAILURE);
    } finally {
      storage?.close();
    }
  },
});
