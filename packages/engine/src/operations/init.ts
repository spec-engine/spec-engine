// packages/engine/src/operations/init.ts
//
// Member onboarding in two steps. `resolveMemberPin` canonicalizes the repo
// directory, refuses a platform dir or anything inside a spec-engine/ tree,
// and decides where the pin comes from: the caller's override, the platform's
// derived version, or the `spec-engine@1` fallback. `writeMemberConfig` then
// writes `spec-engine.member.json`, or reports the one already there. Every
// refusal is worded without a command prefix; the surface adds its own.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { SpecConfigSchema } from "@spec-engine/shared";
import { z } from "zod";
import packageJson from "../../package.json" with { type: "json" };
import { MEMBER_CONFIG_FILENAME } from "../constants";
import { readRepoConfig, warnIfRetiredManifest } from "../indexer/discover";
import { detectContext, findPlatformDirUpward } from "../onboarding/context";
import { fail, type OpFailure } from "./_result";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface MemberPinInput {
  /** The absolute member repo directory as the caller resolved it. */
  repoDir: string;
  /** A pin the caller supplied; taken as-is (the caller validates its shape). */
  override?: string | undefined;
}

export type PinSource = "override" | "derived" | "fallback";

export interface MemberPin {
  ok: true;
  /** The repo directory with symlinks resolved. */
  canonical: string;
  pin: string;
  source: PinSource;
  /** The platform the pin was derived from, when `source` is `derived`. */
  platformDir: string | null;
  platformVersion: number | null;
}

const ENGINE_PACKAGE_NAME: string = packageJson.name;
const PackageNameSchema = z.object({ name: z.string() });

/** Whether `platformDir` is the engine's own checkout: its package.json carries the engine's package name. */
function isEnginePlatform(platformDir: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(platformDir, "package.json"), "utf8"));
  } catch {
    return false;
  }
  const parsed = PackageNameSchema.safeParse(raw);
  return parsed.success && parsed.data.name === ENGINE_PACKAGE_NAME;
}

function hasSpecEngineSegment(path: string): boolean {
  return path
    .split(sep)
    .filter((s) => s.length > 0)
    .includes("spec-engine");
}

/**
 * Whether `canonical` lies inside a spec-engine/ tree. On the engine's own
 * checkout only the path below the platform root is judged, so the checkout's
 * own name never counts.
 * @spec INIT-030
 */
function insideSpecTree(canonical: string): boolean {
  if (!hasSpecEngineSegment(canonical)) return false;
  const platformDir = findPlatformDirUpward(canonical);
  if (platformDir === null || !isEnginePlatform(platformDir)) return true;
  return hasSpecEngineSegment(relative(platformDir, canonical));
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
  let canonical: string;
  try {
    canonical = realpathSync(repoDir);
  } catch (err) {
    return fail("usage", `cannot resolve ${repoDir}: ${errMessage(err)}`);
  }
  let inside: boolean;
  try {
    inside = insideSpecTree(canonical);
  } catch (err) {
    return fail("usage", `cannot resolve ${repoDir}: ${errMessage(err)}`);
  }
  if (inside) {
    return fail(
      "usage",
      `${repoDir} resolves to ${canonical}, which is inside a spec-engine/ tree — refusing to scaffold there.`,
    );
  }
  return { ok: true, canonical };
}

/**
 * @spec INIT-015
 * @spec INIT-016
 * @spec INIT-018
 * @spec INIT-020
 * @spec INIT-031
 */
export async function resolveMemberPin(input: MemberPinInput): Promise<MemberPin | OpFailure> {
  const canon = canonicalize(input.repoDir);
  if (!canon.ok) return canon;
  const { canonical } = canon;

  let ctx: Awaited<ReturnType<typeof detectContext>>;
  try {
    ctx = await detectContext(canonical);
  } catch (err) {
    return fail("usage", errMessage(err));
  }
  if (ctx.kind === "platform") {
    return fail(
      "usage",
      `${canonical} is a platform dir (contains spec-engine/) — pass a member subdir or cd into one`,
    );
  }

  if (input.override !== undefined) {
    return {
      ok: true,
      canonical,
      pin: input.override,
      source: "override",
      platformDir: null,
      platformVersion: null,
    };
  }
  if (ctx.platformVersion !== null && ctx.platformDir !== null) {
    warnIfRetiredManifest(ctx.platformDir, ctx.platformVersion);
    return {
      ok: true,
      canonical,
      pin: `spec-engine@${ctx.platformVersion}`,
      source: "derived",
      platformDir: ctx.platformDir,
      platformVersion: ctx.platformVersion,
    };
  }
  return {
    ok: true,
    canonical,
    pin: "spec-engine@1",
    source: "fallback",
    platformDir: null,
    platformVersion: null,
  };
}

export interface WriteMemberConfigInput {
  canonical: string;
  pin: string;
  /** Rewrite an existing config, keeping its `ignore` list and `members` glob. */
  force?: boolean | undefined;
  /** Repo-relative directory prefixes the scanner skips. Written on a fresh config only. */
  ignore?: string[] | undefined;
  /** A glob that expands each matching subdirectory into its own member. Written on a fresh config only. */
  members?: string | undefined;
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

type PreservedFields = Pick<MemberConfigFields, "ignore" | "members">;

/** The valid `ignore` list and `members` glob to carry forward, or the refusal when either is malformed. */
function preservedFields(
  configPath: string,
  raw: Record<string, unknown>,
): ({ ok: true } & PreservedFields) | OpFailure {
  const refuse = (field: string, expected: string): OpFailure =>
    fail(
      "conflict",
      `existing ${configPath} has an invalid ${field} field (expected ${expected}); refusing to overwrite. Edit manually.`,
    );
  const out: { ok: true } & PreservedFields = { ok: true };
  const isEntry = (e: unknown): e is string => typeof e === "string" && e.length > 0;
  if (raw.ignore !== undefined) {
    if (!Array.isArray(raw.ignore) || !raw.ignore.every(isEntry)) {
      return refuse("ignore", "an array of non-empty strings");
    }
    out.ignore = raw.ignore;
  }
  if (raw.members !== undefined) {
    if (!isEntry(raw.members)) return refuse("members", "a non-empty glob string");
    out.members = raw.members;
  }
  return out;
}

interface MemberConfigFields {
  specs: string;
  ignore?: string[] | undefined;
  members?: string | undefined;
}

async function write(configPath: string, fields: MemberConfigFields): Promise<void> {
  const body: MemberConfigFields = { specs: fields.specs };
  if (fields.ignore !== undefined) body.ignore = fields.ignore;
  if (fields.members !== undefined) body.members = fields.members;
  await Bun.write(configPath, `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * Without `force` an existing config is reported, not touched. With `force`
 * the pin is rewritten and a valid `ignore` list and `members` glob preserved;
 * unknown keys or a malformed field refuse, since overwriting them would lose
 * user data.
 * @spec INIT-017
 * @spec INIT-019
 * @spec INIT-027
 */
export async function writeMemberConfig(
  input: WriteMemberConfigInput,
): Promise<WriteMemberConfigResult | OpFailure> {
  const { canonical, pin } = input;
  const configPath = join(canonical, MEMBER_CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    await write(configPath, { specs: pin, ignore: input.ignore, members: input.members });
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
  const kept = preservedFields(configPath, rawRes.raw);
  if (!kept.ok) return kept;
  await write(configPath, { specs: pin, ignore: kept.ignore, members: kept.members });
  return { ok: true, action: "wrote", path: configPath, pin };
}
