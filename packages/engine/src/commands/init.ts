// packages/engine/src/commands/init.ts
//
// `spec init [repo]`: declare a member and write its `spec-engine.member.json`
// pin. The command resolves the repo argument, validates the `--specs` shape,
// and renders; placement, declaration, and the write live in
// operations/init.ts. Exit codes are 0 (wrote, or already configured) and 2;
// never 1.

import { resolve } from "node:path";
import { SpecConfigSchema } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { EXIT } from "../constants";
import { type InitMemberResult, initMember } from "../operations/init";
import { exitOnFailure } from "./_shared";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The repo directory: the positional when it is a non-empty string, else the cwd. */
function resolveRepoArg(repoRaw: string | undefined): string {
  const repoArg = typeof repoRaw === "string" && repoRaw.length > 0 ? repoRaw : process.cwd();
  return resolve(repoArg);
}

/** The `--specs` value checked against the shared config schema; an empty one gets its own message. */
function validateOverride(specs: string): string {
  if (specs.length === 0) {
    console.error(
      "spec init: --specs validation failed: value must be of the form spec-engine@N (got empty string)",
    );
    process.exit(EXIT.USAGE);
  }
  try {
    return SpecConfigSchema.parse({ specs }).specs;
  } catch (err) {
    console.error(`spec init: --specs validation failed: ${errMessage(err)}`);
    process.exit(EXIT.USAGE);
  }
}

/** The source line to print. The fallback prints its note on stdout, in text mode only. */
function sourceText(result: InitMemberResult, json: boolean): string {
  if (result.source === "override") return "--specs flag";
  if (result.source === "derived") {
    return `derived platform version (max domain version ${result.platformVersion} at ${result.platformDir})`;
  }
  if (!json) {
    console.log("spec init: no platform spec-engine/ found upward — falling back to spec-engine@1");
  }
  return "fallback @1";
}

/** The `spec init` flow over parsed arguments. The onboarding prompt runs it inline for a repository. */
export async function runInit(args: {
  repo?: string | undefined;
  specs?: string | undefined;
  platform?: string | undefined;
  force?: boolean | undefined;
  json?: boolean | undefined;
}): Promise<void> {
  const json = Boolean(args.json);
  const override = typeof args.specs === "string" ? validateOverride(args.specs) : undefined;
  const result = await initMember({
    repoDir: resolveRepoArg(args.repo),
    override,
    platformRoot: typeof args.platform === "string" ? args.platform : undefined,
    force: Boolean(args.force),
  });
  if (!result.ok) exitOnFailure("spec init", result);
  const source = sourceText(result, json);
  const { declared, linked } = result;

  if (result.action === "already-configured") {
    if (json) {
      console.log(
        JSON.stringify({
          action: "already-configured",
          path: result.path,
          pin: result.pin,
          extra_fields: result.extraFields,
          declared,
          linked,
        }),
      );
      return;
    }
    console.log("spec init: already configured");
    console.log(`  path: ${result.path}`);
    console.log(`  pin:  ${result.pin}`);
    if (result.extraFields.length > 0) {
      console.log(
        `  warning: file has extra fields (${result.extraFields.join(", ")}); --force would refuse to overwrite. Edit manually if you intend to re-run with --force.`,
      );
    }
    for (const file of declared) console.log(`  declared: ${file}`);
    if (linked !== null) console.log(`  linked: ${linked}`);
    return;
  }

  if (json) {
    console.log(
      JSON.stringify({
        action: "wrote",
        path: result.path,
        pin: result.pin,
        source,
        declared,
        linked,
      }),
    );
    return;
  }
  console.log(`spec init: wrote ${result.path}`);
  console.log(`  pin:    ${result.pin}`);
  console.log(`  source: ${source}`);
  for (const file of declared) console.log(`  declared: ${file}`);
  if (linked !== null) console.log(`  linked: ${linked}`);
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Declare a member repo and scaffold its spec-engine.member.json",
  },
  args: {
    repo: {
      type: "positional",
      required: false,
      description: "Member repo directory (default: cwd)",
    },
    specs: {
      type: "string",
      description: "Pin override (e.g. spec-engine@2). Validated via SpecConfigSchema.",
    },
    platform: {
      type: "string",
      description:
        "Platform root for a declared member checked out outside the platform folder; recorded in platform-map's per-user file.",
    },
    force: {
      type: "boolean",
      description:
        "Overwrite an existing spec-engine.member.json (refuses if existing has extra keys).",
    },
    json: {
      type: "boolean",
      description:
        "Print the outcome as one JSON object ({action, path, pin, …}). Errors stay text-on-stderr + exit 2.",
    },
  },
  async run({ args }) {
    await runInit(args);
  },
});
