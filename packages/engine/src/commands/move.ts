// packages/engine/src/commands/move.ts
//
// `spec move <KEY-NNN> <NEW-DOMAIN>`: the cross-domain supersede. The command
// normalizes the target key and renders; the guards, both writes, and the
// retag worklist live in operations/move.ts.

import { defineCommand, type ParsedArgs } from "citty";
import { normalizeDomainKey } from "../authoring/domains";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { coldFreshTags } from "../operations/_index";
import { type MoveInput, move } from "../operations/move";
import { ID_RE } from "../parser/grammar";
import { renderReqTags } from "../resolve/format";
import { platformDirArg, resolvePlatformDir } from "./_args";
import { exitOnFailure, handleNotAPlatform, printWarnings } from "./_shared";

/** Flags to the operation's input. An absent flag leaves the field to be copied from the source. */
function inputFromArgs(
  args: MoveArgs,
  platformDir: string,
  id: string,
  targetKey: string,
): MoveInput {
  const input: MoveInput = { platformDir, id, targetKey, noBump: Boolean(args.noBump) };
  if (typeof args.text === "string") input.statement = args.text;
  if (typeof args.why === "string") input.why = args.why;
  if (typeof args.lives === "string") {
    const lives = args.lives.trim();
    input.livesIn = lives === "" ? [] : [lives];
  }
  return input;
}

const moveArgs = {
  id: {
    type: "positional",
    required: true,
    description: "The requirement id to move (KEY-NNN; must be Active)",
  },
  newDomain: {
    type: "positional",
    required: true,
    description: "The target domain key (must already exist; spec domain new <KEY> first)",
  },
  platformDir: platformDirArg,
  text: {
    type: "string",
    description: "Rewrite the successor's Requirement (default: copied from the source)",
  },
  why: {
    type: "string",
    description: "Rewrite the successor's Why (default: copied from the source)",
  },
  lives: {
    type: "string",
    description: "Rewrite the successor's Lives in (default: copied from the source)",
  },
  noBump: {
    type: "boolean",
    description: "Do not bump either envelope's specVersion",
  },
  json: {
    type: "boolean",
    description:
      "Emit { old_id, new_id, from_file, to_file, source_spec_version, target_spec_version, retag } as JSON",
  },
} as const;

type MoveArgs = ParsedArgs<typeof moveArgs>;

export const moveCommand = defineCommand({
  meta: {
    name: "move",
    description:
      "Move a requirement to another domain: mint the successor in <NEW-DOMAIN> carrying the source's fields, mark the source superseded, bump both specVersions, and emit the retag worklist.",
  },
  args: moveArgs,
  async run({ args }) {
    const id = args.id;
    const rawTargetKey = args.newDomain;
    const platformDir = resolvePlatformDir(args);

    if (!ID_RE.test(id)) {
      console.error(`spec move: id must be a requirement id (KEY-NNN); got ${id}`);
      process.exit(EXIT.USAGE);
    }
    const targetKey = normalizeDomainKey(rawTargetKey);
    if (targetKey === "") {
      console.error(
        `spec move: <NEW-DOMAIN> must be a domain key; got ${JSON.stringify(rawTargetKey)}`,
      );
      process.exit(EXIT.USAGE);
    }
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    const result = await move(
      inputFromArgs(args, platformDir, id, targetKey),
      coldFreshTags(platformDir),
    );
    if (!result.ok) exitOnFailure("spec move", result);
    printWarnings("spec move", result.warnings);

    const { newId, fromFile, toFile, sourceSpecVersion, targetSpecVersion, retag } = result;
    const sourceKey = id.slice(0, id.indexOf("-"));
    if (args.json) {
      console.log(
        JSON.stringify({
          old_id: id,
          new_id: newId,
          from_file: fromFile,
          to_file: toFile,
          source_spec_version: sourceSpecVersion,
          target_spec_version: targetSpecVersion,
          retag,
        }),
      );
    } else {
      console.log(`moved ${id} → ${newId} (${sourceKey} → ${targetKey})`);
      if (sourceSpecVersion !== null || targetSpecVersion !== null) {
        console.log(
          `specVersion: ${sourceKey}→${sourceSpecVersion}, ${targetKey}→${targetSpecVersion}`,
        );
      }
      if (retag.length > 0) {
        console.log(`retag ${retag.length} site(s) from ${id} to ${newId}:`);
        console.log(renderReqTags(retag, "text"));
      }
    }
    if (retag.length > 0) {
      console.error(
        `note: spec check will report SUPERSEDED_REFERENCED at each remaining ${id} tag until the sites are retagged to ${newId}`,
      );
    }
  },
});
