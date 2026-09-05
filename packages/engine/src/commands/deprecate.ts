// packages/engine/src/commands/deprecate.ts
//
// `spec deprecate <KEY-NNN> --reason "..."`: end a requirement with a recorded
// reason and print the tags still bound to it. The command checks the input
// shape and renders; the gates and the write live in operations/deprecate.ts.

import { defineCommand } from "citty";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { coldFreshTags } from "../operations/_index";
import { deprecate } from "../operations/deprecate";
import { ID_RE } from "../parser/grammar";
import { renderReqTags } from "../resolve/format";
import { platformDirArg, resolvePlatformDir } from "./_args";
import { exitOnFailure, handleNotAPlatform } from "./_shared";

export const deprecateCommand = defineCommand({
  meta: {
    name: "deprecate",
    description:
      "Mark a requirement end-of-life with a recorded reason (a requirement is never deleted)",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "Requirement id to deprecate (KEY-NNN)",
    },
    platformDir: platformDirArg,
    reason: {
      type: "string",
      description: "Why this requirement is end-of-life (required — the durable record)",
    },
    json: {
      type: "boolean",
      description: "Print { id, file, reason, sites } instead of text",
    },
  },
  async run({ args }) {
    const id = args.id as string;
    const platformDir = resolvePlatformDir(args);
    const reason = ((args.reason as string | undefined) ?? "").trim();

    if (!ID_RE.test(id)) {
      console.error(`spec deprecate: id must be a requirement id (KEY-NNN); got ${id}`);
      process.exit(EXIT.USAGE);
    }
    if (reason === "") {
      console.error(
        "spec deprecate: --reason is required — the reason is the durable record of why this requirement ended",
      );
      process.exit(EXIT.USAGE);
    }
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    const result = await deprecate({ platformDir, id, reason }, coldFreshTags(platformDir));
    if (!result.ok) exitOnFailure("spec deprecate", result);
    const { file, sites } = result;

    if (args.json) {
      console.log(JSON.stringify({ id, file, reason, sites }));
      return;
    }
    console.log(`deprecated ${id} in ${file} — reason recorded`);
    if (sites.length > 0) {
      console.error(
        `${sites.length} code tag(s) still bind ${id} — remove or retag them (spec check reports each as DEPRECATED_REFERENCED):`,
      );
      console.error(renderReqTags(sites, "text"));
    }
  },
});
