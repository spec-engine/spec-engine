import { defineCommand, type ParsedArgs } from "citty";
import { duplicateRefs } from "../check/duplicates";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { coldDuplicateScan } from "../operations/_index";
import { type AmendFields, amend } from "../operations/amend";
import { ID_RE } from "../parser/grammar";
import { jsonArg, listFlag, platformDirArg, relatesArg, resolvePlatformDir } from "./_args";
import { exitOnFailure, handleNotAPlatform, printDuplicates, printWarnings } from "./_shared";

const amendArgs = {
  id: {
    type: "positional",
    required: true,
    description: "The requirement id to amend (KEY-NNN; must be Active or Draft)",
  },
  platformDir: platformDirArg,
  text: { type: "string", description: "New Requirement (statement) field value" },
  why: { type: "string", description: "New Why it matters field value" },
  relates: relatesArg,
  issue: {
    type: "string",
    description:
      "Ticket that motivated this amendment — recorded as amends-via provenance (opaque, never a requirement id)",
  },
  term: { type: "string", description: "New TERM headword (term field; TERM ids)" },
  aliases: {
    type: "string",
    description: "New TERM comma-separated aliases (aliases[]; TERM ids)",
  },
  json: jsonArg,
} as const;

type AmendArgs = ParsedArgs<typeof amendArgs>;

export const amendCommand = defineCommand({
  meta: {
    name: "amend",
    description:
      "Revise a requirement's fields in place (same id, no version bump). A released requirement's statement and why are superseded instead; --relates and --issue still amend.",
  },
  args: amendArgs,
  async run({ args, rawArgs }) {
    const id = args.id;
    if (!ID_RE.test(id)) {
      console.error(`spec amend: id must be a requirement id (KEY-NNN); got ${id}`);
      process.exit(EXIT.USAGE);
      return;
    }
    const platformDir = resolvePlatformDir(args);
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    const fields = fieldsFromArgs(args, rawArgs);

    const result = await amend({ platformDir, id, fields }, coldDuplicateScan(platformDir));
    if (!result.ok) exitOnFailure("spec amend", result);
    printWarnings("spec amend", result.warnings);
    printDuplicates(result.possibleDuplicates);
    if (args.json) {
      console.log(
        JSON.stringify({
          id,
          file: result.file,
          fields_changed: result.fieldsChanged,
          possible_duplicates: duplicateRefs(result.possibleDuplicates),
        }),
      );
    } else {
      console.log(`amended ${id} in ${result.file} (${result.fieldsChanged.join(", ")})`);
    }
  },
});

/** At least one field is required; `--text` and `--term` must be non-empty. Exits 2 otherwise. */
function assertAmendFlags(args: AmendArgs): void {
  const hasIssue = args.issue !== undefined && args.issue.trim() !== "";
  const hasField =
    args.text !== undefined ||
    args.why !== undefined ||
    args.relates !== undefined ||
    args.term !== undefined ||
    args.aliases !== undefined;
  if (!hasField && !hasIssue) {
    console.error(
      "spec amend: nothing to amend — pass at least one of --text / --why / --relates / --term / --aliases",
    );
    process.exit(EXIT.USAGE);
  }
  if (args.text !== undefined && args.text.trim() === "") {
    console.error("spec amend: --text must be a non-empty Requirement");
    process.exit(EXIT.USAGE);
  }
  if (args.term !== undefined && args.term.trim() === "") {
    console.error("spec amend: --term must be a non-empty headword");
    process.exit(EXIT.USAGE);
  }
}

function splitAliases(raw: string): string[] {
  return raw === ""
    ? []
    : raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
}

/**
 * Flags to the operation's field set: trimmed, with empty why → null and an empty relates list → [].
 * @spec REQ-078
 */
function fieldsFromArgs(args: AmendArgs, rawArgs: readonly string[]): AmendFields {
  assertAmendFlags(args);
  const fields: AmendFields = {};
  if (args.text !== undefined) fields.statement = args.text.trim();
  if (args.why !== undefined) {
    const v = args.why.trim();
    fields.why = v === "" ? null : v;
  }
  const relates = listFlag(rawArgs, "relates", args.relates);
  if (relates !== undefined) fields.relates = relates;
  if (args.term !== undefined) fields.term = args.term.trim();
  if (args.issue !== undefined && args.issue.trim() !== "") fields.issue = args.issue.trim();
  if (args.aliases !== undefined) fields.aliases = splitAliases(args.aliases.trim());
  return fields;
}
