// packages/engine/src/commands/guard.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec GUARD-001
// @spec GUARD-008
//
// `spec guard [platformDir] [--against <ref>] [--json]` — loss detection for
// requirements about to be steamrolled.
//
// The derived index has no memory: if a change deletes an Active requirement
// together with its @spec tags and its tests, the rebuilt index is simply
// consistent-but-smaller and nothing alarms. Git IS the memory. This command
// diffs the requirement derivation at a ref (default HEAD) against the working
// tree and reports what is about to be lost.
//
//   Exit 0 — clean (or a non-git context, GUARD-008).
//   Exit 1 — one or more losses found.
//   Exit 2 — usage error (not a spec platform).
//
// GUARD-008 never-fail-non-git: if the ref does not resolve — a non-git tree, a
// fresh repo with no HEAD, an unfetched/misspelled ref — print a
// NOT_A_GIT_REPO warning to stderr and exit 0. The guard is a pre-commit safety
// net, not a hard git dependency.
//
// The worktree index is rebuilt FRESH each run (`fresh: true`) so the "last tag
// survives?" question always reflects the current tree, exactly like
// `spec check --ci` — correctness never trusts a warm index here.
//
// D-08 grep-fence: no bun:sqlite import — worktree tag counts flow through the
// Storage interface via withReadStorage / collectFacts.

import { resolve } from "node:path";
import { defineCommand } from "citty";
import { gitRefResolves } from "../base/gitBase";
import { defaultIndexPath, EXIT } from "../constants";
import { collectFacts } from "../guard/collect";
import { renderGuard } from "../guard/format";
import type { Loss } from "../guard/losses";
import { classifyLosses } from "../guard/losses";
import { withReadStorage } from "./_shared";

export const guardCommand = defineCommand({
  meta: {
    name: "guard",
    description:
      "Loss detection: diff the requirement derivation at a git ref (default HEAD) against the working tree and block requirements about to be steamrolled.",
  },
  args: {
    platformDir: {
      type: "positional",
      required: false,
      description: "Platform directory containing spec-engine/ (default: cwd)",
    },
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
    const platformDir = resolve((args.platformDir as string | undefined) ?? process.cwd());
    const ref = (args.against as string | undefined) ?? "HEAD";
    const jsonMode = Boolean(args.json);

    // GUARD-008: non-git / unresolvable ref → warn to stderr, exit 0. Checked
    // BEFORE any index build so a non-git context is cheap and never fails.
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

    // Rebuild the worktree index fresh, then gather facts + classify. A
    // non-platform dir throws NotASpecPlatformError inside withReadStorage →
    // friendly message + exit 2 (GUARD-001 usage error).
    let losses: Loss[] = [];
    await withReadStorage(
      { platformDir, dbPath: defaultIndexPath(platformDir), fresh: true },
      async (storage) => {
        losses = classifyLosses(await collectFacts(platformDir, ref, storage));
      },
    );

    console.log(renderGuard(losses, jsonMode ? "json" : "text", ref));
    process.exit(losses.length > 0 ? EXIT.FAILURE : EXIT.OK);
  },
});
