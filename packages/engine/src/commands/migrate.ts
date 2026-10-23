import { defineCommand } from "citty";
import { assertSpecPlatform } from "../indexer/discover";
import { migrate } from "../operations/migrate";
import { jsonArg, platformDirArg, resolvePlatformDir } from "./_args";
import { exitOnFailure, handleNotAPlatform } from "./_shared";

export const migrateCommand = defineCommand({
  meta: {
    name: "migrate",
    description:
      "Remove the retired livesIn and verifiedIn fields from every SPEC.json, rewriting only the files that carry one",
  },
  args: {
    platformDir: platformDirArg,
    json: jsonArg,
  },
  async run({ args }) {
    const platformDir = resolvePlatformDir(args);
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }
    const result = await migrate(platformDir);
    if (!result.ok) exitOnFailure("spec migrate", result);
    if (args.json) {
      console.log(JSON.stringify({ files: result.files }));
      return;
    }
    if (result.files.length === 0) console.error("spec migrate: nothing to migrate");
    for (const f of result.files) console.log(`migrated ${f}`);
  },
});
