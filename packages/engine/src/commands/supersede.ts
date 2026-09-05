// packages/engine/src/commands/supersede.ts
//
// `spec supersede <KEY-NNN>`: flip a shipped requirement to superseded, mint
// its successor, and print the retag worklist. The command resolves the
// successor text (a flag, or a prompt on a TTY) and renders; every guard and
// the write live in operations/supersede.ts.

import { defineCommand } from "citty";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { coldFreshTags } from "../operations/_index";
import { type SupersedeInput, supersede, supersedeTarget } from "../operations/supersede";
import { ID_RE } from "../parser/grammar";
import { renderReqTags } from "../resolve/format";
import { platformDirArg, resolvePlatformDir } from "./_args";
import { exitOnFailure, handleNotAPlatform, printWarnings } from "./_shared";
import { askLine } from "./req";

/**
 * The successor's statement: `--text`, or a prompt on a TTY. The target is
 * checked first so a bad id is reported before the text is asked for. An
 * empty `--text` and a non-TTY without one exit 2; an empty prompt answer
 * aborts with exit 0 and nothing written.
 */
async function resolveSuccessorText(
  args: Record<string, unknown>,
  platformDir: string,
  id: string,
): Promise<string> {
  const flag = ((args.text as string | undefined) ?? "").trim();
  if (flag !== "") return flag;
  const target = await supersedeTarget(platformDir, id);
  if (!target.ok) exitOnFailure("spec supersede", target);
  if (typeof args.text === "string") {
    console.error("spec supersede: --text must be a non-empty Requirement");
    process.exit(EXIT.USAGE);
  }
  if (!process.stdin.isTTY) {
    console.error(
      "spec supersede: --text <requirement> is required when stdin is not a TTY (the successor needs its truth)",
    );
    process.exit(EXIT.USAGE);
  }
  console.error(`Superseding ${id} — new entry will be allocated next`);
  const answer = (await askLine("Successor Requirement: ")).trim();
  if (answer === "") {
    console.error("spec supersede: aborted — empty Requirement, nothing written");
    process.exit(EXIT.OK);
  }
  return answer;
}

function splitAliases(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Flags to the operation's input. An absent flag leaves the field to be copied from the predecessor. */
function inputFromArgs(
  args: Record<string, unknown>,
  platformDir: string,
  id: string,
  statement: string,
): SupersedeInput {
  const input: SupersedeInput = { platformDir, id, statement, noBump: Boolean(args.noBump) };
  if (typeof args.why === "string") input.why = args.why;
  if (typeof args.lives === "string") {
    const lives = args.lives.trim();
    input.livesIn = lives === "" ? [] : [lives];
  }
  if (typeof args.term === "string") input.term = args.term;
  if (typeof args.aliases === "string") input.aliases = splitAliases(args.aliases);
  const issue = ((args.issue as string | undefined) ?? "").trim();
  if (issue !== "") input.issue = issue;
  return input;
}

export const supersedeCommand = defineCommand({
  meta: {
    name: "supersede",
    description:
      "Supersede a shipped requirement: flip it to superseded, mint the successor, bump specVersion, and emit the retag worklist.",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "The requirement id to supersede (KEY-NNN; must be Active)",
    },
    platformDir: platformDirArg,
    text: {
      type: "string",
      description:
        "The successor's Requirement field. Required when stdin is not a TTY; prompted otherwise.",
    },
    why: {
      type: "string",
      description: "Successor's Why it matters (default: copied from the old entry)",
    },
    lives: {
      type: "string",
      description: "Successor's Lives in (default: copied from the old entry)",
    },
    term: {
      type: "string",
      description: "TERM successor's headword (default: copied from the old entry; TERM ids only)",
    },
    aliases: {
      type: "string",
      description:
        "TERM successor's comma-separated aliases (default: copied from the old entry; TERM ids only)",
    },
    noBump: {
      type: "boolean",
      description: "Do not bump the envelope specVersion",
    },
    issue: {
      type: "string",
      description:
        "Ticket that caused this supersession — recorded as supersedes-via on the predecessor and created on the successor (opaque provenance)",
    },
    json: {
      type: "boolean",
      description:
        "Emit { old_id, new_id, file, spec_version, retag } as JSON instead of the text summary",
    },
  },
  async run({ args }) {
    const id = args.id as string;
    if (!ID_RE.test(id)) {
      console.error(`spec supersede: id must be a requirement id (KEY-NNN); got ${id}`);
      process.exit(EXIT.USAGE);
    }
    const platformDir = resolvePlatformDir(args);
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    const statement = await resolveSuccessorText(args, platformDir, id);
    const result = await supersede(
      inputFromArgs(args, platformDir, id, statement),
      coldFreshTags(platformDir),
    );
    if (!result.ok) exitOnFailure("spec supersede", result);
    printWarnings("spec supersede", result.warnings);

    const { newId, file, specVersion, retag } = result;
    if (args.json) {
      console.log(
        JSON.stringify({ old_id: id, new_id: newId, file, spec_version: specVersion, retag }),
      );
    } else {
      console.log(`superseded ${id} → ${newId} in ${file}`);
      if (specVersion !== null) console.log(`specVersion bumped to ${specVersion}`);
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
