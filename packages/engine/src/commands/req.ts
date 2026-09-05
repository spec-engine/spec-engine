// packages/engine/src/commands/req.ts
//
// @spec REQ-022
// @spec REQ-023
// @spec REQ-024
// @spec REQ-025
// @spec REQ-027
// @spec REQ-028
// @spec REQ-029
// @spec REQ-026
// @spec REQ-030
// @spec REQ-032
// @spec REQ-037
//
// `spec req <domain-prefix> [platformDir]`: piped, the next unused id; with
// `--text`, a non-interactive mint; on a TTY, the per-field prompt flow. The
// prompts render to stderr so stdout stays machine-parseable.

import { createInterface } from "node:readline";
import { defineCommand, type ParsedArgs } from "citty";
import { domainScope } from "../authoring/domains";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { mint } from "../operations/mint";
import { nextId } from "../operations/nextId";
import { jsonArg, platformDirArg, resolvePlatformDir } from "./_args";
import { exitOnFailure, handleNotAPlatform, printWarnings } from "./_shared";

const reqArgs = {
  domainPrefix: {
    type: "positional",
    required: true,
    description: "Domain key or unique case-insensitive prefix (e.g. `bil` for BILLING)",
  },
  platformDir: platformDirArg,
  json: jsonArg,
  text: {
    type: "string",
    description:
      "Non-interactive authoring: the Requirement field. When set, the entry appends with zero prompts.",
  },
  why: { type: "string", description: "Why it matters field (only with --text)" },
  lives: { type: "string", description: "Lives in field (only with --text)" },
  issue: {
    type: "string",
    description:
      "Originating ticket id, recorded as created-provenance on the entry (only with --text; opaque — never a requirement id)",
  },
} as const;

type ReqArgs = ParsedArgs<typeof reqArgs>;

export const reqCommand = defineCommand({
  meta: {
    name: "req",
    description:
      "Author a new requirement interactively (TTY) or print the next unused id (non-TTY)",
  },
  args: reqArgs,
  async run({ args }) {
    const input = args.domainPrefix;
    const platformDir = resolvePlatformDir(args);
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    const allocated = await nextId(platformDir, input);
    if (!allocated.ok) exitOnFailure("spec req", allocated);
    const { key, nextId: id } = allocated;

    const textFlag = args.text;
    if (textFlag !== undefined) {
      await mintFromFlags(platformDir, key, textFlag, args);
      return;
    }
    const hasFieldFlags =
      typeof args.why === "string" ||
      typeof args.lives === "string" ||
      typeof args.issue === "string";
    if (hasFieldFlags) {
      console.error(
        "spec req: --why/--lives/--issue require --text (the Requirement field is mandatory)",
      );
      process.exit(EXIT.USAGE);
      return;
    }
    if (args.json) {
      console.log(JSON.stringify({ domain: key, next_id: id }));
      return;
    }
    if (!process.stdin.isTTY) {
      console.log(id);
      return;
    }
    await mintInteractively(platformDir, key, id);
  },
});

/** The `--text` path: field flags, zero prompts. */
async function mintFromFlags(
  platformDir: string,
  key: string,
  textFlag: string,
  args: ReqArgs,
): Promise<void> {
  const statement = textFlag.trim();
  if (statement === "") {
    console.error("spec req: --text must be a non-empty Requirement");
    process.exit(EXIT.USAGE);
  }
  await printResolvedCharter(platformDir, key);
  const lives = (args.lives ?? "").trim();
  await mintAndReport(platformDir, key, {
    statement,
    why: (args.why ?? "").trim(),
    livesIn: lives ? [lives] : [],
    issue: (args.issue ?? "").trim() || undefined,
    json: Boolean(args.json),
  });
}

/** The TTY path: one prompt per field, rendered on stderr; an empty Requirement aborts with exit 0. */
async function mintInteractively(platformDir: string, key: string, id: string): Promise<void> {
  console.error(`Authoring ${id} — Active`);
  await printResolvedCharter(platformDir, key);
  const requirement = (await askLine("Requirement: ")).trim();
  if (requirement === "") {
    console.error("spec req: aborted — empty Requirement, nothing written");
    process.exit(EXIT.OK);
    return;
  }
  const why = (await askLine("Why it matters: ")).trim();
  const lives = (await askLine("Lives in: ")).trim();
  await mintAndReport(platformDir, key, {
    statement: requirement,
    why,
    livesIn: lives ? [lives] : [],
    issue: undefined,
    json: false,
  });
}

/** Mint through the shared operation and print its outcome in this command's voice. */
async function mintAndReport(
  platformDir: string,
  key: string,
  fields: { statement: string; why: string; livesIn: string[]; issue?: string; json: boolean },
): Promise<void> {
  const result = await mint({ platformDir, key, ...fields });
  if (!result.ok) exitOnFailure("spec req", result);
  printWarnings("spec req", result.warnings);
  if (fields.json) {
    console.log(
      JSON.stringify(
        result.clauses
          ? { id: result.id, file: result.file, clauses: result.clauses }
          : { id: result.id, file: result.file },
      ),
    );
  } else {
    console.log(`appended ${result.id} to ${result.file}`);
  }
}

/** Echo the resolved domain's charter to stderr at authoring time. */
// @spec CHRT-012
async function printResolvedCharter(platformDir: string, key: string): Promise<void> {
  const scope = await domainScope(platformDir, key);
  if (scope !== null && scope.trim() !== "") {
    console.error(`Charter — ${key}: ${scope}`);
  } else {
    console.error(`spec req: no charter set for ${key}`);
  }
}

/** Read one line from stdin with the prompt on stderr. */
export async function askLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((res) => rl.question(question, res));
  } finally {
    rl.close();
  }
}
