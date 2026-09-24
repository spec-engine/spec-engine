// packages/engine/src/commands/accept.ts
//
// `spec accept <KEY-NNN>`: promote a Draft requirement to Active. The gate and
// the write live in operations/accept.ts.

import { defineCommand } from "citty";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { accept } from "../operations/accept";
import { ID_RE } from "../parser/grammar";
import { jsonArg, platformDirArg, resolvePlatformDir } from "./_args";
import { exitOnFailure, handleNotAPlatform } from "./_shared";

export const acceptCommand = defineCommand({
  meta: {
    name: "accept",
    description: "Promote a Draft requirement to Active (same id, fields untouched)",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "Draft requirement id to accept (KEY-NNN)",
    },
    platformDir: platformDirArg,
    json: jsonArg,
  },
  async run({ args }) {
    const id = args.id;
    if (!ID_RE.test(id)) {
      console.error(`spec accept: id must be a requirement id (KEY-NNN); got ${id}`);
      process.exit(EXIT.USAGE);
      return;
    }
    const platformDir = resolvePlatformDir(args);
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    const result = await accept({ platformDir, id });
    if (!result.ok) exitOnFailure("spec accept", result);
    if (args.json) {
      console.log(JSON.stringify({ id, file: result.file }));
      return;
    }
    console.log(`accepted ${id} in ${result.file} — now Active`);
  },
});
