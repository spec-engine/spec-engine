// packages/engine/src/commands/get.ts
//
// `spec get <KEY-NNN> [platformDir]`: one requirement's full record. An
// unknown id is `[]` on stdout with guidance on stderr and exit 0; a malformed
// id is exit 2.

import { defineCommand } from "citty";
import { EXIT, resolveDbPath } from "../constants";
import { formatNoRequirementsIndexed } from "../indexer/discover";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { getRecord } from "../operations/records";
import { ID_RE } from "../parser/grammar";
import { renderRecords } from "../records/format";
import {
  freshArg,
  jsonArg,
  noPromptArg,
  outArg,
  platformDirArg,
  resolvePlatformDir,
} from "./_args";
import { assertContainedPath, withReadStorage } from "./_shared";

export const getCommand = defineCommand({
  meta: {
    name: "get",
    description:
      "Print one requirement's full record (id, status, key, seq, versions, statement) from the derived index.",
  },
  args: {
    reqId: {
      type: "positional",
      required: true,
      description: "Requirement id, e.g. BILLING-009",
    },
    platformDir: platformDirArg,
    out: outArg,
    json: jsonArg,
    fresh: freshArg,
    noPrompt: noPromptArg,
  },
  async run({ args }) {
    const reqId = ((args.reqId as string | undefined) ?? "").trim();
    if (!ID_RE.test(reqId)) {
      console.error(`spec get: id must be a requirement id (KEY-NNN); got ${reqId}`);
      process.exit(EXIT.USAGE);
      return;
    }

    const platformDir = resolvePlatformDir(args);
    const outArgValue = args.out as string | undefined;
    const dbPath = resolveDbPath(platformDir, outArgValue);
    if (outArgValue) assertContainedPath(dbPath, platformDir, "spec get: --out");

    await maybePromptForOnboarding({
      platformDir,
      args: { noPrompt: args.noPrompt as boolean | undefined },
    });

    await withReadStorage({ platformDir, dbPath, fresh: !!args.fresh }, (storage) => {
      const result = getRecord(storage, reqId);
      if (result.row === null) {
        console.error(
          result.platformEmpty
            ? formatNoRequirementsIndexed(platformDir)
            : `spec get: no requirement ${reqId} in the index under ${platformDir} (check the id, or re-run with --fresh after editing specs)`,
        );
        console.log("[]");
        return;
      }
      console.log(args.json ? JSON.stringify(result.row) : renderRecords([result.row], "text"));
    });
  },
});
