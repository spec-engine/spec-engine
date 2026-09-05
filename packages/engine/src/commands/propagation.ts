// packages/engine/src/commands/propagation.ts
//
// @spec PROP-005

import { defineCommand } from "citty";
import { EXIT, resolveDbPath } from "../constants";
import { formatNoRequirementsIndexed } from "../indexer/discover";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { propagation } from "../operations/reads";
import { renderPropagation } from "../propagation/format";
import {
  freshArg,
  jsonArg,
  noPromptArg,
  outArg,
  platformDirArg,
  resolvePlatformDir,
} from "./_args";
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
    platformDir: platformDirArg,
    out: outArg,
    json: jsonArg,
    fresh: freshArg,
    noPrompt: noPromptArg,
  },
  async run({ args }) {
    const reqId = (args.reqId ?? "").trim();
    if (!reqId) {
      console.error("spec propagation: <reqId> is required (e.g., spec propagation BILLING-009)");
      process.exit(EXIT.USAGE);
      return;
    }

    const platformDir = resolvePlatformDir(args);
    const outArgValue = args.out;
    const dbPath = resolveDbPath(platformDir, outArgValue);
    if (outArgValue) assertContainedPath(dbPath, platformDir, "spec propagation: --out");

    await maybePromptForOnboarding({
      platformDir,
      args: { noPrompt: args.noPrompt },
    });

    await withReadStorage({ platformDir, dbPath, fresh: !!args.fresh }, (storage) => {
      const result = propagation(storage, reqId);
      if (!args.json && result.platformEmpty) {
        console.error(formatNoRequirementsIndexed(platformDir));
        return;
      }
      console.log(renderPropagation(result.rows, args.json ? "json" : "text"));
    });
  },
});
