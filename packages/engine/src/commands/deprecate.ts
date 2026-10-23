import { defineCommand } from "citty";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { deprecate } from "../operations/deprecate";
import { ID_RE } from "../parser/grammar";
import { renderReqTags } from "../resolve/format";
import { platformDirArg, resolvePlatformDir } from "./_args";
import { cliFreshTags, exitOnFailure, handleNotAPlatform } from "./_shared";

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
      description: "Print { id, file, reason, removed } instead of text",
    },
  },
  async run({ args }) {
    const id = args.id;
    const platformDir = resolvePlatformDir(args);
    const reason = (args.reason ?? "").trim();

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

    const result = await deprecate({ platformDir, id, reason }, cliFreshTags(platformDir));
    if (!result.ok) exitOnFailure("spec deprecate", result);
    const { file, removed } = result;

    if (args.json) {
      console.log(JSON.stringify({ id, file, reason, removed }));
      return;
    }
    console.log(`deprecated ${id} in ${file} — reason recorded`);
    if (removed.length > 0) {
      console.log(`removed ${removed.length} tag(s) of ${id}:`);
      console.log(renderReqTags(removed, "text"));
    }
  },
});
