// packages/engine/src/commands/list.ts
//
// `spec list [platformDir] [--domain KEY] [--status S]`: every requirement
// record in (key, seq) order, history included. A `--status` value outside
// active | draft | superseded | deprecated is exit 2.

import { defineCommand, type ParsedArgs } from "citty";
import { normalizeDomainKey } from "../authoring/domains";
import { EXIT, resolveDbPath } from "../constants";
import { formatNoRequirementsIndexed } from "../indexer/discover";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import {
  type ListRecordsFilter,
  listRecords,
  requirementStatus,
  STATUS_WORDS,
} from "../operations/records";
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

const STATUS_CHOICES = STATUS_WORDS.join("|");

/** The filter the flags name; a status outside the known set exits 2. */
function filterFromArgs(args: ListArgs): ListRecordsFilter {
  const filter: ListRecordsFilter = {};
  if (typeof args.domain === "string" && args.domain.trim() !== "") {
    filter.key = normalizeDomainKey(args.domain);
  }
  if (typeof args.status === "string") {
    const status = requirementStatus(args.status);
    if (status === null) {
      console.error(`spec list: --status must be one of ${STATUS_CHOICES}; got ${args.status}`);
      process.exit(EXIT.USAGE);
    }
    filter.status = status;
  }
  return filter;
}

const listArgs = {
  platformDir: platformDirArg,
  domain: { type: "string", description: "Only this domain key (e.g. BILLING)" },
  status: {
    type: "string",
    description: `Only this status: ${STATUS_CHOICES}`,
  },
  out: outArg,
  json: jsonArg,
  fresh: freshArg,
  noPrompt: noPromptArg,
} as const;

type ListArgs = ParsedArgs<typeof listArgs>;

export const listCommand = defineCommand({
  meta: {
    name: "list",
    description:
      "Print every requirement record in (key, seq) order, including superseded and deprecated history. --domain and --status filter.",
  },
  args: listArgs,
  async run({ args }) {
    const filter = filterFromArgs(args);
    const platformDir = resolvePlatformDir(args);
    const outArgValue = args.out;
    const dbPath = resolveDbPath(platformDir, outArgValue);
    if (outArgValue) assertContainedPath(dbPath, platformDir, "spec list: --out");

    await maybePromptForOnboarding({
      platformDir,
      args: { noPrompt: args.noPrompt },
    });

    await withReadStorage({ platformDir, dbPath, fresh: !!args.fresh }, (storage) => {
      const result = listRecords(storage, filter);
      if (!args.json && result.rows.length === 0) {
        console.error(
          result.platformEmpty
            ? formatNoRequirementsIndexed(platformDir)
            : `spec list: no requirements match under ${platformDir}`,
        );
        return;
      }
      console.log(renderRecords(result.rows, args.json ? "json" : "text"));
    });
  },
});
