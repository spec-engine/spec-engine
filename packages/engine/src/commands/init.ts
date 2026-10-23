import { dirname, join, resolve } from "node:path";
import { SpecConfigSchema } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { CANONICAL_SPECS_DIR, EXIT, isExistingDir } from "../constants";
import { type AgentSurfaceResult, writeAgentSurface } from "../operations/agentSurface";
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

function printSurface(surface: AgentSurfaceResult, json: boolean): void {
  for (const hint of surface.hints) console.error(`spec init: ${hint}`);
  if (json) return;
  for (const file of surface.written) console.log(`  agent surface: ${file}`);
}

/** A package's surface goes to its monorepo root; a member's to the member. */
function surfaceFor(result: InitMemberResult, force: boolean): AgentSurfaceResult {
  const { placement } = result;
  return writeAgentSurface({
    dir: placement.kind === "package" ? placement.platformDir : dirname(result.path),
    platformDir: placement.kind === "loose" ? null : placement.platformDir,
    force,
  });
}

/** Unresolvable paths answer false; `initMember` reports them. */
function isPlatformDir(dir: string): boolean {
  try {
    return isExistingDir(join(dir, CANONICAL_SPECS_DIR));
  } catch {
    return false;
  }
}

/** @spec INIT-043 */
function initPlatformDir(dir: string, force: boolean, json: boolean): void {
  const surface = writeAgentSurface({ dir, platformDir: dir, force });
  if (json) {
    console.log(JSON.stringify({ action: "surface-only", agent_surface: surface.written }));
  } else {
    console.log(`spec init: ${dir} is a platform directory; wrote no member config`);
  }
  printSurface(surface, json);
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
  const force = Boolean(args.force);
  const override = typeof args.specs === "string" ? validateOverride(args.specs) : undefined;
  const result = await initMember({
    repoDir: resolveRepoArg(args.repo),
    override,
    platformRoot: typeof args.platform === "string" ? args.platform : undefined,
    force,
  });
  if (!result.ok) exitOnFailure("spec init", result);
  const source = sourceText(result, json);
  const { declared, linked } = result;
  const surface = surfaceFor(result, force);
  const agent_surface = surface.written;

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
          agent_surface,
        }),
      );
      printSurface(surface, json);
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
    printSurface(surface, json);
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
        agent_surface,
      }),
    );
    printSurface(surface, json);
    return;
  }
  console.log(`spec init: wrote ${result.path}`);
  console.log(`  pin:    ${result.pin}`);
  console.log(`  source: ${source}`);
  for (const file of declared) console.log(`  declared: ${file}`);
  if (linked !== null) console.log(`  linked: ${linked}`);
  printSurface(surface, json);
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description:
      "Declare a member repo, scaffold its spec-engine.member.json, and install the agent surface",
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
        "Overwrite an existing spec-engine.member.json (refuses if existing has extra keys) and a differing req-author skill.",
    },
    json: {
      type: "boolean",
      description:
        "Print the outcome as one JSON object ({action, path, pin, …}). Errors stay text-on-stderr + exit 2.",
    },
  },
  async run({ args }) {
    const repoDir = resolveRepoArg(args.repo);
    if (isPlatformDir(repoDir)) initPlatformDir(repoDir, Boolean(args.force), Boolean(args.json));
    else await runInit(args);
  },
});
