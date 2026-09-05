// packages/engine/src/commands/amend.ts
//
// `spec amend <KEY-NNN>`: revise an unshipped entry in place. The command
// parses flags into the operation's field set and reports; every gate lives
// in operations/amend.ts.

import { defineCommand } from "citty";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { coldFreshTags } from "../operations/_index";
import { type AmendFields, amend } from "../operations/amend";
import { ID_RE } from "../parser/grammar";
import { jsonArg, platformDirArg, resolvePlatformDir } from "./_args";
import { exitOnFailure, handleNotAPlatform, printWarnings } from "./_shared";

export const amendCommand = defineCommand({
  meta: {
    name: "amend",
    description:
      "Revise an unshipped requirement's fields in place (same id, no specVersion bump). Supersede shipped truth instead.",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "The requirement id to amend (KEY-NNN; must be Active or Draft)",
    },
    platformDir: platformDirArg,
    text: { type: "string", description: "New Requirement (statement) field value" },
    why: { type: "string", description: "New Why it matters field value" },
    lives: { type: "string", description: "New Lives in (livesIn) field value" },
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
  },
  async run({ args }) {
    const id = args.id as string;
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

    const fields = fieldsFromArgs(args);

    const result = await amend({ platformDir, id, fields }, coldFreshTags(platformDir));
    if (!result.ok) exitOnFailure("spec amend", result);
    printWarnings("spec amend", result.warnings);
    if (args.json) {
      console.log(JSON.stringify({ id, file: result.file, fields_changed: result.fieldsChanged }));
    } else {
      console.log(`amended ${id} in ${result.file} (${result.fieldsChanged.join(", ")})`);
    }
  },
});

/** Presence of each amendable flag. */
interface AmendFlags {
  hasText: boolean;
  hasIssue: boolean;
  hasWhy: boolean;
  hasLives: boolean;
  hasTerm: boolean;
  hasAliases: boolean;
}

function amendFlags(args: Record<string, unknown>): AmendFlags {
  return {
    hasText: typeof args.text === "string",
    hasIssue: typeof args.issue === "string" && (args.issue as string).trim() !== "",
    hasWhy: typeof args.why === "string",
    hasLives: typeof args.lives === "string",
    hasTerm: typeof args.term === "string",
    hasAliases: typeof args.aliases === "string",
  };
}

/** At least one field is required; `--text` and `--term` must be non-empty. Exits 2 otherwise. */
function assertAmendFlags(args: Record<string, unknown>, f: AmendFlags): void {
  if (!f.hasText && !f.hasWhy && !f.hasLives && !f.hasTerm && !f.hasAliases && !f.hasIssue) {
    console.error(
      "spec amend: nothing to amend — pass at least one of --text / --why / --lives / --term / --aliases",
    );
    process.exit(EXIT.USAGE);
  }
  if (f.hasText && (args.text as string).trim() === "") {
    console.error("spec amend: --text must be a non-empty Requirement");
    process.exit(EXIT.USAGE);
  }
  if (f.hasTerm && (args.term as string).trim() === "") {
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

/** Flags to the operation's field set: trimmed, with empty why → null and empty lives → []. */
function fieldsFromArgs(args: Record<string, unknown>): AmendFields {
  const f = amendFlags(args);
  assertAmendFlags(args, f);
  const fields: AmendFields = {};
  if (f.hasText) fields.statement = (args.text as string).trim();
  if (f.hasWhy) {
    const v = (args.why as string).trim();
    fields.why = v === "" ? null : v;
  }
  if (f.hasLives) {
    const v = (args.lives as string).trim();
    fields.livesIn = v === "" ? [] : [v];
  }
  if (f.hasTerm) fields.term = (args.term as string).trim();
  if (f.hasIssue) fields.issue = (args.issue as string).trim();
  if (f.hasAliases) fields.aliases = splitAliases((args.aliases as string).trim());
  return fields;
}
