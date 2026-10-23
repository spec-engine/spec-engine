import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatStatementFinding, RULE_ZERO } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { CANONICAL_SPECS_DIR, EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { lint } from "../operations/lint";
import { exit } from "../stdout";
import { jsonArg, platformDirArg, resolvePlatformDir } from "./_args";
import { exitOnFailure, handleNotAPlatform } from "./_shared";

/** A lone positional that holds spec-engine/ is the platform dir, not a scope. */
function splitPositionals(args: { target?: string | undefined; platformDir?: string | undefined }) {
  const { target, platformDir } = args;
  if (
    target !== undefined &&
    platformDir === undefined &&
    existsSync(join(resolve(target), CANONICAL_SPECS_DIR))
  ) {
    return { target: undefined, platformDir: resolve(target) };
  }
  return { target, platformDir: resolvePlatformDir({ platformDir }) };
}

export const lintCommand = defineCommand({
  meta: {
    name: "lint",
    description:
      "Print every statement-rule finding for the platform, one domain (KEY), or one requirement (KEY-NNN); exit 1 on any",
  },
  args: {
    target: {
      type: "positional",
      required: false,
      description: "Domain key or requirement id (default: the whole platform)",
    },
    platformDir: platformDirArg,
    all: { type: "boolean", description: "Judge Draft requirements as well as Active ones" },
    json: jsonArg,
  },
  async run({ args }) {
    const { target, platformDir } = splitPositionals(args);
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }
    const result = await lint({ platformDir, target, all: !!args.all });
    if (!result.ok) exitOnFailure("spec lint", result);
    // @spec CHCK-052
    if (args.json) {
      console.log(
        JSON.stringify(
          result.findings.map(({ req_id, rule, detail, reason, source_file, line }) => ({
            req_id,
            rule,
            detail,
            reason,
            source_file,
            line,
          })),
        ),
      );
    } else {
      for (const f of result.findings) console.log(`${f.req_id} ${formatStatementFinding(f)}`);
      if (result.findings.length > 0) console.error(RULE_ZERO);
    }
    await exit(result.findings.length > 0 ? EXIT.FAILURE : EXIT.OK);
  },
});
