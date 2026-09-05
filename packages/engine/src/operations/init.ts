// packages/engine/src/operations/init.ts
//
// Member onboarding. `resolveMemberPin` places the target against platform-map
// (a declared member, an undeclared repository in the platform folder, a
// workspace package, or a loose directory), refuses a platform dir or a
// spec-engine/ tree, and decides where the pin comes from. `initMember` then
// declares an undeclared repository through platform-map and writes the pin.
// Every refusal is worded without a command prefix; the surface adds its own.

import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  applyInit,
  applyLink,
  detect,
  discover,
  type InitPlan,
  planInit,
  planLink,
} from "@spec-engine/platform-map";
import { SpecConfigSchema } from "@spec-engine/shared";
import packageJson from "../../package.json" with { type: "json" };
import { CANONICAL_SPECS_DIR, isExistingDir, MEMBER_CONFIG_FILENAME } from "../constants";
import {
  derivePlatformVersion,
  isEnginePlatform,
  locateMember,
  packageColumnName,
  readRepoConfig,
  warnIfRetiredManifest,
} from "../indexer/discover";
import { fail, type OpFailure } from "./_result";

const PLATFORM_MAP_FILENAME = "platform-map.json";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface MemberPinInput {
  /** The member repo directory as the caller resolved it. */
  repoDir: string;
  /** A pin the caller supplied; taken as-is (the caller validates its shape). */
  override?: string | undefined;
  /**
   * The platform root, for a declared member checked out outside the platform
   * folder. Its location is recorded in platform-map's per-user file first.
   */
  platformRoot?: string | undefined;
}

export type PinSource = "override" | "derived" | "fallback";

/** What the target is to its platform. */
export type Placement =
  | { kind: "member"; name: string; platformDir: string; conventional: boolean }
  | { kind: "undeclared"; name: string; platformDir: string }
  | { kind: "package"; name: string; platformDir: string }
  | { kind: "loose" };

export interface MemberPin {
  ok: true;
  /** The repo directory with symlinks resolved. */
  canonical: string;
  pin: string;
  source: PinSource;
  /** The platform the pin was derived from, when `source` is `derived`. */
  platformDir: string | null;
  platformVersion: number | null;
  placement: Placement;
  /** The per-user file written to locate the platform, when `platformRoot` was given. */
  linked: string | null;
}

const ENGINE_PACKAGE_NAME: string = packageJson.name;

function hasSpecEngineSegment(path: string): boolean {
  return path
    .split(sep)
    .filter((s) => s.length > 0)
    .includes(CANONICAL_SPECS_DIR);
}

/** The repo directory with symlinks resolved, or the refusal. */
function canonicalize(repoDir: string): { ok: true; canonical: string } | OpFailure {
  let repoStat: ReturnType<typeof statSync>;
  try {
    repoStat = statSync(repoDir, { throwIfNoEntry: false });
  } catch (err) {
    return fail("usage", `cannot resolve ${repoDir}: ${errMessage(err)}`);
  }
  if (!repoStat?.isDirectory()) {
    return fail("usage", `${repoDir} does not exist or is not a directory`);
  }
  try {
    return { ok: true, canonical: realpathSync(repoDir) };
  } catch (err) {
    return fail("usage", `cannot resolve ${repoDir}: ${errMessage(err)}`);
  }
}

/**
 * The spec-engine/ path-segment refusal. On the engine's own checkout only
 * the path below the platform root is judged, so the checkout's name never
 * counts.
 * @spec INIT-018
 * @spec INIT-030
 */
function judgeSpecTree(
  repoDir: string,
  canonical: string,
  root: string | null,
): { ok: true } | OpFailure {
  if (!hasSpecEngineSegment(canonical)) return { ok: true };
  const judged =
    root !== null && isEnginePlatform(root, ENGINE_PACKAGE_NAME)
      ? relative(root, canonical)
      : canonical;
  if (hasSpecEngineSegment(judged)) {
    return fail(
      "usage",
      `${repoDir} resolves to ${canonical}, which is inside a spec-engine/ tree — refusing to scaffold there.`,
    );
  }
  return { ok: true };
}

/**
 * A repository directly under a platform folder is declared as a member; a
 * directory a monorepo's workspace manifest lists is a package pin; a plain
 * directory that platform-map cannot declare is refused, since a pin there
 * would index nothing.
 */
function placeConventional(canonical: string, root: string): Placement | OpFailure {
  const name = basename(canonical);
  if (detect(root).mode === "monorepo") {
    const pkg = packageColumnName(root, canonical);
    if (pkg !== null) return { kind: "package", name: pkg, platformDir: root };
    return fail(
      "usage",
      `${root} is a monorepo and ${name} is not one of its workspace packages; add it to the workspace manifest to give it a coverage column`,
    );
  }
  if (!discover(root).some((c) => c.name === name)) {
    return fail(
      "usage",
      `${canonical} has no .git entry or package.json, so platform-map cannot declare it as a member of ${root}`,
    );
  }
  return { kind: "undeclared", name, platformDir: root };
}

/** Where the target sits in its platform, or the refusal. */
function place(repoDir: string, canonical: string): { ok: true; placement: Placement } | OpFailure {
  let location: ReturnType<typeof locateMember>;
  try {
    location = locateMember(canonical);
  } catch (err) {
    return fail("usage", `cannot resolve ${repoDir}: ${errMessage(err)}`);
  }
  const judged = judgeSpecTree(repoDir, canonical, location?.root ?? null);
  if (!judged.ok) return judged;
  if (location === null) return { ok: true, placement: { kind: "loose" } };
  const { root, member, conventional } = location;
  if (member !== null) {
    return {
      ok: true,
      placement: { kind: "member", name: member, platformDir: root, conventional },
    };
  }
  if (conventional) {
    const placed = placeConventional(canonical, root);
    return "kind" in placed ? { ok: true, placement: placed } : placed;
  }
  const pkg = packageColumnName(root, canonical);
  if (pkg !== null)
    return { ok: true, placement: { kind: "package", name: pkg, platformDir: root } };
  return fail(
    "usage",
    `${canonical} is neither a declared member nor a workspace package of the platform at ${root}`,
  );
}

/**
 * Record in platform-map's per-user file where a declared member's checkout
 * lives when it is not a child of the platform folder.
 * @spec INIT-039
 */
function link(canonical: string, platformRoot: string): { ok: true; userFile: string } | OpFailure {
  if (!existsSync(join(canonical, PLATFORM_MAP_FILENAME))) {
    return fail(
      "usage",
      `${canonical} carries no platform-map.json marker, so it is not a declared member; declare it from the platform folder with \`spec init <name>\``,
    );
  }
  const plan = planLink(canonical, { root: resolve(platformRoot) });
  if (plan.root === null) {
    return fail(
      "usage",
      `cannot link ${canonical} to ${platformRoot}: ${plan.problem ?? "unknown"}`,
    );
  }
  const result = applyLink(plan);
  return { ok: true, userFile: result.written[0] ?? plan.userFile };
}

/**
 * @spec INIT-015
 * @spec INIT-016
 * @spec INIT-017
 * @spec INIT-027
 */
export async function resolveMemberPin(input: MemberPinInput): Promise<MemberPin | OpFailure> {
  const canon = canonicalize(input.repoDir);
  if (!canon.ok) return canon;
  const { canonical } = canon;
  if (isExistingDir(join(canonical, CANONICAL_SPECS_DIR))) {
    return fail(
      "usage",
      `${canonical} is a platform dir (contains spec-engine/) — pass a member subdir or cd into one`,
    );
  }
  let linked: string | null = null;
  if (input.platformRoot !== undefined) {
    const result = link(canonical, input.platformRoot);
    if (!result.ok) return result;
    linked = result.userFile;
  }
  const placed = place(input.repoDir, canonical);
  if (!placed.ok) return placed;
  const { placement } = placed;
  const base = { ok: true as const, canonical, placement, linked };

  if (input.override !== undefined) {
    return {
      ...base,
      pin: input.override,
      source: "override",
      platformDir: null,
      platformVersion: null,
    };
  }
  if (placement.kind !== "loose") {
    const platformVersion = await derivePlatformVersion(placement.platformDir);
    warnIfRetiredManifest(placement.platformDir, platformVersion);
    return {
      ...base,
      pin: `spec-engine@${platformVersion}`,
      source: "derived",
      platformDir: placement.platformDir,
      platformVersion,
    };
  }
  return {
    ...base,
    pin: "spec-engine@1",
    source: "fallback",
    platformDir: null,
    platformVersion: null,
  };
}

/**
 * The platform-map writes that make `name` a member of the platform at
 * `platformDir`: a platform file entry and a marker. Nothing is written here;
 * `applyInit` writes the plan, and skips every file that already exists.
 * @spec INIT-038
 */
export function planDeclare(
  platformDir: string,
  name: string,
): { ok: true; plan: InitPlan } | OpFailure {
  const plan = planInit(platformDir);
  if (plan.problem !== undefined) {
    return fail("conflict", `cannot declare ${name} in ${platformDir}: ${plan.problem}`);
  }
  const candidate = plan.candidates.find((c) => c.name === name);
  if (candidate === undefined) {
    return fail(
      "usage",
      `${join(platformDir, name)} has no .git entry or package.json, so platform-map cannot declare it as a member`,
    );
  }
  if (candidate.marker !== undefined && candidate.marker !== plan.platformName) {
    return fail(
      "conflict",
      `${name} carries a platform-map.json marker for platform "${candidate.marker}", not "${plan.platformName}"`,
    );
  }
  return { ok: true, plan };
}

export interface WriteMemberConfigInput {
  canonical: string;
  pin: string;
  /** Rewrite an existing config, keeping its `ignore` list. */
  force?: boolean | undefined;
  /** Repo-relative directory prefixes the scanner skips. Written on a fresh config only. */
  ignore?: string[] | undefined;
}

export type WriteMemberConfigResult =
  | { ok: true; action: "wrote"; path: string; pin: string }
  | {
      ok: true;
      action: "already-configured";
      path: string;
      /** The pin the existing file carries. */
      pin: string;
      /** Keys outside the known set; `--force` would refuse while they exist. */
      extraFields: string[];
    };

const KNOWN_KEYS = new Set<string>(SpecConfigSchema.keyof().options);

/** The existing config as a raw object; never through the schema, which would strip unknown keys. */
async function readRawConfig(
  configPath: string,
): Promise<{ ok: true; raw: Record<string, unknown> } | OpFailure> {
  let text: string;
  try {
    text = await Bun.file(configPath).text();
  } catch (err) {
    return fail("conflict", `existing ${configPath} could not be read: ${errMessage(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return fail("conflict", `existing ${configPath} failed to parse: ${errMessage(err)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail("conflict", `existing ${configPath} is not a JSON object`);
  }
  return { ok: true, raw: raw as Record<string, unknown> };
}

/** The valid `ignore` list to carry forward, or the refusal when it is malformed. */
function preservedIgnore(
  configPath: string,
  raw: Record<string, unknown>,
): { ok: true; ignore: string[] | undefined } | OpFailure {
  if (raw.ignore === undefined) return { ok: true, ignore: undefined };
  const isEntry = (e: unknown): e is string => typeof e === "string" && e.length > 0;
  if (!Array.isArray(raw.ignore) || !raw.ignore.every(isEntry)) {
    return fail(
      "conflict",
      `existing ${configPath} has an invalid ignore field (expected an array of non-empty strings); refusing to overwrite. Edit manually.`,
    );
  }
  return { ok: true, ignore: raw.ignore };
}

async function write(
  configPath: string,
  specs: string,
  ignore: string[] | undefined,
): Promise<void> {
  const body: { specs: string; ignore?: string[] } = { specs };
  if (ignore !== undefined) body.ignore = ignore;
  await Bun.write(configPath, `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * Without `force` an existing config is reported, not touched. With `force`
 * the pin is rewritten and a valid `ignore` list preserved; unknown keys or a
 * malformed `ignore` refuse, since overwriting them would lose user data.
 * @spec INIT-019
 * @spec INIT-020
 * @spec INIT-036
 */
export async function writeMemberConfig(
  input: WriteMemberConfigInput,
): Promise<WriteMemberConfigResult | OpFailure> {
  const { canonical, pin } = input;
  const configPath = join(canonical, MEMBER_CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    await write(configPath, pin, input.ignore);
    return { ok: true, action: "wrote", path: configPath, pin };
  }

  const rawRes = await readRawConfig(configPath);
  if (!rawRes.ok) return rawRes;
  const extraFields = Object.keys(rawRes.raw).filter((k) => !KNOWN_KEYS.has(k));

  if (!input.force) {
    let existing: { specs: string };
    try {
      existing = await readRepoConfig(configPath);
    } catch (err) {
      return fail("conflict", errMessage(err));
    }
    return {
      ok: true,
      action: "already-configured",
      path: configPath,
      pin: existing.specs,
      extraFields,
    };
  }
  if (extraFields.length > 0) {
    return fail(
      "conflict",
      `existing ${configPath} has extra fields (${extraFields.join(", ")}); refusing to overwrite. Edit manually.`,
    );
  }
  const kept = preservedIgnore(configPath, rawRes.raw);
  if (!kept.ok) return kept;
  await write(configPath, pin, kept.ignore);
  return { ok: true, action: "wrote", path: configPath, pin };
}

export interface InitMemberInput extends MemberPinInput {
  force?: boolean | undefined;
  ignore?: string[] | undefined;
}

export type InitMemberResult = WriteMemberConfigResult & {
  source: PinSource;
  platformDir: string | null;
  platformVersion: number | null;
  placement: Placement;
  /** platform-map files written to declare the member (a platform file, a marker); empty when it was already declared. */
  declared: string[];
  linked: string | null;
};

/**
 * Declare the target through platform-map when the platform file does not
 * list it, then write its pin. The declaration plan and the config refusals
 * are both judged before the first byte is written.
 * @spec INIT-038
 */
export async function completeInit(
  resolved: MemberPin,
  opts: { pin: string; force?: boolean | undefined; ignore?: string[] | undefined },
): Promise<InitMemberResult | OpFailure> {
  const { placement } = resolved;
  let plan: InitPlan | null = null;
  let name = "";
  if (placement.kind === "undeclared" || (placement.kind === "member" && placement.conventional)) {
    const planned = planDeclare(placement.platformDir, placement.name);
    if (!planned.ok) return planned;
    plan = planned.plan;
    name = placement.name;
  }
  const written = await writeMemberConfig({
    canonical: resolved.canonical,
    pin: opts.pin,
    force: opts.force,
    ignore: opts.ignore,
  });
  if (!written.ok) return written;
  const declared = plan === null ? [] : applyInit(plan, [name]).written;
  return {
    ...written,
    source: resolved.source,
    platformDir: resolved.platformDir,
    platformVersion: resolved.platformVersion,
    placement,
    declared,
    linked: resolved.linked,
  };
}

/** The whole `spec init` operation: place, declare when needed, and write the pin. */
export async function initMember(input: InitMemberInput): Promise<InitMemberResult | OpFailure> {
  const resolved = await resolveMemberPin(input);
  if (!resolved.ok) return resolved;
  return completeInit(resolved, { pin: resolved.pin, force: input.force, ignore: input.ignore });
}
