// packages/engine/src/commands/term.ts
//
// `spec term`: the glossary-term authoring surface over operations/term.ts.
//
//   spec term <name> --def <definition> [--aliases a,b] [--section s]  — author
//   spec term                                                          — next unused TERM id
//   spec term list                                                     — enumerate
//   spec term revise <TERM-NNN> --def <definition>                     — revise in place, bump the version
//   spec term confirm <KEY-NNN> <TERM-NNN>                             — re-pin a citation
//
// `list`, `revise`, and `confirm` are dispatched from the root `run` on the
// first positional rather than as citty subcommands: citty refuses any first
// positional that is not a registered subcommand name, which would break the
// bare `spec term <name>` authoring form. A term literally named `list`,
// `revise`, or `confirm` cannot be authored through the bare form.

import { resolve } from "node:path";
import { defineCommand } from "citty";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { withIndex } from "../operations/_index";
import {
  confirmTerm,
  listTerms,
  mintTerm,
  nextTermId,
  reviseTerm,
  TERM_KEY,
} from "../operations/term";
import { ID_RE } from "../parser/grammar";
import { platformDirArg } from "./_args";
import { exitOnFailure, handleNotAPlatform, printWarnings } from "./_shared";

/** Split a `--aliases "a, b, c"` flag into a trimmed, empty-filtered array. */
function parseAliases(raw: string | undefined): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Resolve the optional platformDir positional + run the platform guard. */
function resolvePlatform(platformDirRaw: string | undefined): string {
  const platformDir = resolve(platformDirRaw ?? process.cwd());
  try {
    assertSpecPlatform(platformDir);
  } catch (e) {
    handleNotAPlatform(e);
  }
  return platformDir;
}

/**
 * `spec term <name>`: author a term when a definition is supplied; otherwise a
 * pure id query that mirrors `spec req` (bare next id, or `{ domain, next_id }`
 * under `--json`) with zero writes.
 */
async function authorOrQuery(opts: {
  name: string;
  platformDirRaw: string | undefined;
  def: string | undefined;
  aliasesRaw: string | undefined;
  section: string | undefined;
  json: boolean;
}): Promise<void> {
  const platformDir = resolvePlatform(opts.platformDirRaw);
  const { nextId } = await nextTermId(platformDir);

  if (opts.def === undefined) {
    if (opts.json) {
      console.log(JSON.stringify({ domain: TERM_KEY, next_id: nextId }));
    } else {
      console.log(nextId);
    }
    return;
  }

  const definition = opts.def.trim();
  if (definition === "") {
    console.error("spec term: --def must be a non-empty definition");
    process.exit(EXIT.USAGE);
    return;
  }

  const result = await mintTerm({
    platformDir,
    term: opts.name,
    definition,
    aliases: parseAliases(opts.aliasesRaw),
    section: opts.section,
  });
  if (!result.ok) exitOnFailure("spec term", result);
  printWarnings("spec term", result.warnings);
  if (opts.json) {
    console.log(JSON.stringify({ id: result.id, file: result.file }));
  } else {
    console.log(`appended ${result.id} to ${result.file}`);
  }
}

/** `spec term list`: the TERM store from the filesystem, sorted by id. */
async function listTermsCommand(platformDirRaw: string | undefined, json: boolean): Promise<void> {
  const platformDir = resolvePlatform(platformDirRaw);
  const result = await listTerms(platformDir);
  if (!result.ok) exitOnFailure("spec term list", result);
  if (json) {
    console.log(JSON.stringify(result.rows));
    return;
  }
  for (const row of result.rows) {
    console.log(`${row.id}  ${row.term}  ${row.status}`);
  }
}

/** `spec term revise <TERM-NNN> --def`: rewrite the definition in place and bump the version. */
async function reviseTermCommand(opts: {
  id: string;
  platformDirRaw: string | undefined;
  def: string | undefined;
  noBump: boolean;
  json: boolean;
}): Promise<void> {
  const { id } = opts;
  if (!ID_RE.test(id)) {
    console.error(`spec term revise: id must be a requirement id (TERM-NNN); got ${id}`);
    process.exit(EXIT.USAGE);
  }
  if (id.slice(0, id.indexOf("-")) !== TERM_KEY) {
    console.error(`spec term revise: ${id} is not a TERM id — revise operates on the TERM store`);
    process.exit(EXIT.USAGE);
  }
  const platformDir = resolvePlatform(opts.platformDirRaw);
  const definition = (opts.def ?? "").trim();
  if (definition === "") {
    console.error("spec term revise: --def <definition> is required (a non-empty revision)");
    process.exit(EXIT.USAGE);
  }

  const result = await reviseTerm({ platformDir, id, definition, noBump: opts.noBump });
  if (!result.ok) exitOnFailure("spec term revise", result);
  printWarnings("spec term revise", result.warnings);
  if (opts.json) {
    console.log(JSON.stringify({ id, file: result.file, spec_version: result.specVersion }));
  } else {
    console.log(`revised ${id} in ${result.file}`);
    if (result.specVersion !== null) console.log(`specVersion bumped to ${result.specVersion}`);
  }
}

/**
 * `spec term confirm <KEY-NNN> <TERM-NNN>`: re-pin a citation to the term's
 * current version, or to its successor. The index is rebuilt cold afterwards
 * so a warm read reflects the confirmed citation.
 */
async function confirmTermCommand(opts: {
  reqId: string;
  termId: string;
  platformDirRaw: string | undefined;
  json: boolean;
}): Promise<void> {
  const { reqId, termId } = opts;
  if (!ID_RE.test(reqId)) {
    console.error(`spec term confirm: req id must be a requirement id (KEY-NNN); got ${reqId}`);
    process.exit(EXIT.USAGE);
  }
  if (!ID_RE.test(termId) || termId.slice(0, termId.indexOf("-")) !== TERM_KEY) {
    console.error(
      `spec term confirm: ${termId} is not a TERM id — confirm re-pins a TERM citation`,
    );
    process.exit(EXIT.USAGE);
  }
  const platformDir = resolvePlatform(opts.platformDirRaw);

  const result = await confirmTerm({ platformDir, reqId, termId });
  if (!result.ok) exitOnFailure("spec term confirm", result);
  await withIndex({ platformDir, build: "fresh" }, () => undefined);

  const { pinned, file } = result;
  if (opts.json) {
    console.log(JSON.stringify({ req_id: reqId, term_id: result.termId, pinned, file }));
  } else {
    console.log(`confirmed ${reqId} cites ${result.termId} @${pinned} in ${file}`);
  }
}

export const termListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List the glossary TERM entries (id, name, status), sorted by id",
  },
  args: {
    platformDir: platformDirArg,
    json: {
      type: "boolean",
      description: "Emit a sorted array of { id, term, status } instead of the per-line text",
    },
  },
  async run({ args }) {
    await listTermsCommand(args.platformDir, Boolean(args.json));
  },
});

export const termReviseCommand = defineCommand({
  meta: {
    name: "revise",
    description:
      "Revise a TERM's definition IN PLACE (same id) and BUMP the envelope specVersion — the drift signal (A2). Requirements have no such op.",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "The TERM id to revise (TERM-NNN)",
    },
    platformDir: platformDirArg,
    def: { type: "string", description: "The revised definition (statement)" },
    text: { type: "string", description: "Alias for --def (the revised definition)" },
    noBump: { type: "boolean", description: "Do not bump the envelope specVersion" },
    json: {
      type: "boolean",
      description: "Emit { id, file, spec_version } as JSON instead of the text summary",
    },
  },
  async run({ args }) {
    await reviseTermCommand({
      id: args.id,
      platformDirRaw: args.platformDir,
      def: args.def ?? args.text,
      noBump: Boolean(args.noBump),
      json: Boolean(args.json),
    });
  },
});

export const termConfirmCommand = defineCommand({
  meta: {
    name: "confirm",
    description:
      "Re-pin a requirement's TERM citation to the term's current version (clears TERM_DRIFT); re-points to the successor when the term is superseded (clears SUPERSEDED_TERM_REFERENCED).",
  },
  args: {
    reqId: {
      type: "positional",
      required: true,
      description: "The citing requirement id (KEY-NNN)",
    },
    termId: {
      type: "positional",
      required: true,
      description: "The cited TERM id to re-confirm (TERM-NNN)",
    },
    platformDir: platformDirArg,
    json: {
      type: "boolean",
      description: "Emit { req_id, term_id, pinned, file } as JSON instead of the text summary",
    },
  },
  async run({ args }) {
    await confirmTermCommand({
      reqId: args.reqId,
      termId: args.termId,
      platformDirRaw: args.platformDir,
      json: Boolean(args.json),
    });
  },
});

export const termCommand = defineCommand({
  meta: {
    name: "term",
    description:
      "Author a glossary TERM (spec term <name> --def <definition>), list terms (spec term list), or revise a definition in place (spec term revise TERM-NNN)",
  },
  args: {
    name: {
      type: "positional",
      required: true,
      description:
        "The term's headword, or the literal `list` / `revise` verb. Without --def (author form), prints the next unused TERM id.",
    },
    platformDir: platformDirArg,
    extra: {
      type: "positional",
      required: false,
      description:
        "After `revise <TERM-NNN>`: the platform directory (default: cwd). After `confirm <KEY-NNN>`: the TERM-NNN id.",
    },
    extra2: {
      type: "positional",
      required: false,
      description: "After `confirm <KEY-NNN> <TERM-NNN>`: the platform directory (default: cwd)",
    },
    def: { type: "string", description: "The term's definition (stored in the statement field)" },
    text: { type: "string", description: "Alias for --def (the definition)" },
    aliases: { type: "string", description: "Comma-separated synonyms → aliases[]" },
    section: { type: "string", description: "GLOSSARY.md layout bucket" },
    noBump: { type: "boolean", description: "revise: do not bump the envelope specVersion" },
    json: {
      type: "boolean",
      description:
        "Author: { id, file } (or { domain, next_id } as an id query). list: the entries array. revise: { id, file, spec_version }.",
    },
  },
  async run({ args }) {
    const verb = args.name;
    const def = args.def ?? args.text;
    const json = Boolean(args.json);

    if (verb === "list") {
      await listTermsCommand(args.platformDir, json);
      return;
    }
    if (verb === "revise") {
      await reviseTermCommand({
        id: args.platformDir ?? "",
        platformDirRaw: args.extra,
        def,
        noBump: Boolean(args.noBump),
        json,
      });
      return;
    }
    if (verb === "confirm") {
      await confirmTermCommand({
        reqId: args.platformDir ?? "",
        termId: args.extra ?? "",
        platformDirRaw: args.extra2,
        json,
      });
      return;
    }

    await authorOrQuery({
      name: verb,
      platformDirRaw: args.platformDir,
      def,
      aliasesRaw: args.aliases,
      section: args.section,
      json,
    });
  },
});
