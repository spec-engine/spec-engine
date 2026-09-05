// packages/engine/src/commands/init.ts
//
// `spec init [repo]`: write a member's `spec-engine.member.json` pin. The
// command resolves the repo argument, validates the `--specs` shape, and
// renders; the pin decision and the write live in operations/init.ts. Exit
// codes are 0 (wrote, or already configured) and 2; never 1.

import { resolve } from "node:path";
import { SpecConfigSchema } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { EXIT } from "../constants";
import { type MemberPin, resolveMemberPin, writeMemberConfig } from "../operations/init";
import { exitOnFailure } from "./_shared";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The repo directory: the positional when it is a non-empty string, else the cwd. */
function resolveRepoArg(repoRaw: string | undefined): string {
  const repoArg = typeof repoRaw === "string" && repoRaw.length > 0 ? repoRaw : process.cwd();
  return resolve(repoArg);
}

/**
 * The pin to write and the source line to print. An override is checked
 * against the shared config schema here; an empty one gets its own message.
 * The fallback prints its note on stdout, in text mode only.
 */
function resolvePinText(resolved: MemberPin, json: boolean): { pin: string; source: string } {
  if (resolved.source === "override") {
    if (resolved.pin.length === 0) {
      console.error(
        "spec init: --specs validation failed: value must be of the form spec-engine@N (got empty string)",
      );
      process.exit(EXIT.USAGE);
    }
    try {
      const validated = SpecConfigSchema.parse({ specs: resolved.pin });
      return { pin: validated.specs, source: "--specs flag" };
    } catch (err) {
      console.error(`spec init: --specs validation failed: ${errMessage(err)}`);
      process.exit(EXIT.USAGE);
    }
  }
  if (resolved.source === "derived") {
    return {
      pin: resolved.pin,
      source: `derived platform version (max domain version ${resolved.platformVersion} at ${resolved.platformDir})`,
    };
  }
  if (!json) {
    console.log("spec init: no platform spec-engine/ found upward — falling back to spec-engine@1");
  }
  return { pin: resolved.pin, source: "fallback @1" };
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Scaffold spec-engine.member.json into a member repo",
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
    const json = Boolean(args.json);
    const resolved = await resolveMemberPin({
      repoDir: resolveRepoArg(args.repo),
      override: typeof args.specs === "string" ? args.specs : undefined,
    });
    if (!resolved.ok) exitOnFailure("spec init", resolved);
    const { pin, source } = resolvePinText(resolved, json);

    const written = await writeMemberConfig({
      canonical: resolved.canonical,
      pin,
      force: Boolean(args.force),
    });
    if (!written.ok) exitOnFailure("spec init", written);

    if (written.action === "already-configured") {
      if (json) {
        console.log(
          JSON.stringify({
            action: "already-configured",
            path: written.path,
            pin: written.pin,
            extra_fields: written.extraFields,
          }),
        );
        return;
      }
      console.log("spec init: already configured");
      console.log(`  path: ${written.path}`);
      console.log(`  pin:  ${written.pin}`);
      if (written.extraFields.length > 0) {
        console.log(
          `  warning: file has extra fields (${written.extraFields.join(", ")}); --force would refuse to overwrite. Edit manually if you intend to re-run with --force.`,
        );
      }
      return;
    }

    if (json) {
      console.log(JSON.stringify({ action: "wrote", path: written.path, pin, source }));
      return;
    }
    console.log(`spec init: wrote ${written.path}`);
    console.log(`  pin:    ${pin}`);
    console.log(`  source: ${source}`);
  },
});
