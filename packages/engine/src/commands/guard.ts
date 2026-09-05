// packages/engine/src/commands/guard.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec GUARD-019
//
// `spec guard [platformDir] [--against <ref>] [--json]`: the pre-commit loss
// gate. A ref that does not resolve (no git repo, no HEAD, an unknown ref)
// prints NOT_A_GIT_REPO and exits 0 before any index is built; otherwise the
// working-tree index is rebuilt cold and operations/guard.ts names the losses.
// Exit 0 clean, 1 any loss, 2 not a platform.

import { defineCommand } from "citty";
import { gitRefResolves } from "../base/gitBase";
import { defaultIndexPath, EXIT } from "../constants";
import { renderGuard } from "../guard/format";
import type { Loss } from "../guard/losses";
import { guard } from "../operations/guard";
import { platformDirArg, resolvePlatformDir } from "./_args";
import { withReadStorage } from "./_shared";

export const guardCommand = defineCommand({
  meta: {
    name: "guard",
    description:
      "Loss detection: diff the requirement derivation at a git ref (default HEAD) against the working tree and block requirements about to be steamrolled.",
  },
  args: {
    platformDir: platformDirArg,
    against: {
      type: "string",
      description: "Git ref to diff the working tree against (default: HEAD)",
    },
    json: {
      type: "boolean",
      description: "Emit losses as a deterministic, chrome-free JSON array on stdout",
    },
  },
  async run({ args }) {
    const platformDir = resolvePlatformDir(args);
    const ref = args.against ?? "HEAD";
    const jsonMode = Boolean(args.json);

    if (!gitRefResolves(platformDir, ref)) {
      console.error(
        `spec guard: NOT_A_GIT_REPO — ref '${ref}' does not resolve in ${platformDir} ` +
          "(not a git repo, a fresh repo with no commit, or an unfetched/misspelled ref); " +
          "skipping loss detection",
      );
      console.log(
        jsonMode ? "[]" : `✓ spec guard: no requirements about to be lost (non-git context)`,
      );
      process.exit(EXIT.OK);
    }

    let losses: Loss[] = [];
    await withReadStorage(
      { platformDir, dbPath: defaultIndexPath(platformDir), fresh: true },
      async (storage) => {
        losses = (await guard(storage, platformDir, ref)).losses;
      },
    );

    console.log(renderGuard(losses, jsonMode ? "json" : "text", ref));
    process.exit(losses.length > 0 ? EXIT.FAILURE : EXIT.OK);
  },
});
