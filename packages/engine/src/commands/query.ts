// packages/engine/src/commands/query.ts
//
// @spec QURY-005
// @spec QURY-006

import { DEFAULT_QUERY_LIMIT, LIMIT_MAX } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { EXIT, resolveDbPath } from "../constants";
import { formatNoRequirementsIndexed } from "../indexer/discover";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { query } from "../operations/reads";
import { renderQuery } from "../query/format";
import {
  freshArg,
  jsonArg,
  noPromptArg,
  outArg,
  platformDirArg,
  resolvePlatformDir,
} from "./_args";
import { assertContainedPath, withReadStorage } from "./_shared";

/** `--limit` must be a positive integer no greater than LIMIT_MAX; anything else is null. */
export function parseQueryLimit(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const limit = Number.parseInt(raw, 10);
  return limit > LIMIT_MAX ? null : limit;
}

export const queryCommand = defineCommand({
  meta: {
    name: "query",
    description:
      "FTS5 retrieval over requirement text + why. Default LIMIT 10. Query syntax follows SQLite FTS5 MATCH (wrap phrases in double quotes; literal AND/OR/NOT are operators).",
  },
  args: {
    text: {
      type: "positional",
      required: true,
      description: "FTS5 MATCH query (e.g., 'renewal charge')",
    },
    platformDir: platformDirArg,
    out: outArg,
    json: jsonArg,
    fresh: freshArg,
    limit: {
      type: "string",
      default: String(DEFAULT_QUERY_LIMIT),
      description: `Max result count (positive integer, ≤ ${LIMIT_MAX})`,
    },
    noPrompt: noPromptArg,
  },
  async run({ args }) {
    const text = (args.text ?? "").trim();
    if (!text) {
      console.error('spec query: <text> is required (e.g., spec query "renewal charge")');
      process.exit(EXIT.USAGE);
      return;
    }
    const limit = parseQueryLimit(args.limit ?? String(DEFAULT_QUERY_LIMIT));
    if (limit === null) {
      console.error(`spec query: --limit must be a positive integer ≤ ${LIMIT_MAX}`);
      process.exit(EXIT.USAGE);
      return;
    }

    const platformDir = resolvePlatformDir(args);
    const outArgValue = args.out;
    const dbPath = resolveDbPath(platformDir, outArgValue);
    if (outArgValue) assertContainedPath(dbPath, platformDir, "spec query: --out");

    await maybePromptForOnboarding({
      platformDir,
      args: { noPrompt: args.noPrompt },
    });

    await withReadStorage({ platformDir, dbPath, fresh: !!args.fresh }, (storage) => {
      const result = query(storage, text, limit);
      if (!result.ok) {
        console.error(`spec query: ${result.detail}`);
        process.exit(EXIT.USAGE);
        return;
      }
      if (!args.json && result.platformEmpty) {
        console.error(formatNoRequirementsIndexed(platformDir));
        return;
      }
      console.log(renderQuery(result.hits, args.json ? "json" : "text"));
    });
  },
});
