// packages/engine/src/operations/init.ts
//
// Member onboarding in two steps. `resolveMemberPin` canonicalizes the repo
// directory, refuses a platform dir or anything inside a spec-engine/ tree,
// and decides where the pin comes from: the caller's override, the platform's
// derived version, or the `spec-engine@1` fallback. `writeMemberConfig` then
// writes `spec-engine.member.json`, or reports the one already there. Every
// refusal is worded without a command prefix; the surface adds its own.

import { existsSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { MEMBER_CONFIG_FILENAME } from "../constants";
import { readRepoConfig, warnIfRetiredManifest } from "../indexer/discover";
import { detectContext } from "../onboarding/context";
import { fail, type OpFailure } from "./_result";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface MemberPinInput {
  /** The absolute member repo directory as the caller resolved it. */
  repoDir: string;
  /** A pin the caller supplied; taken as-is (the caller validates its shape). */
  override?: string;
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
  const segments = canonical.split(sep).filter((s) => s.length > 0);
  if (segments.includes("spec-engine")) {
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
 * @spec INIT-021
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
  /** Rewrite an existing config, keeping its `ignore` list. */
  force?: boolean;
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

const KNOWN_KEYS = new Set(["specs", "ignore"]);

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

/** A valid `ignore` list to carry forward, or the refusal when the field is malformed. */
function preservedIgnore(
  configPath: string,
  raw: Record<string, unknown>,
): { ok: true; ignore?: string[] } | OpFailure {
  const rawIgnore = raw.ignore;
  if (rawIgnore === undefined) return { ok: true };
  if (!Array.isArray(rawIgnore) || !rawIgnore.every((e) => typeof e === "string" && e.length > 0)) {
    return fail(
      "conflict",
      `existing ${configPath} has an invalid ignore field (expected an array of non-empty strings); refusing to overwrite. Edit manually.`,
    );
  }
  return { ok: true, ignore: rawIgnore as string[] };
}

async function write(configPath: string, pin: string, ignore?: string[]): Promise<void> {
  const body = `${JSON.stringify(ignore !== undefined ? { specs: pin, ignore } : { specs: pin }, null, 2)}\n`;
  await Bun.write(configPath, body);
}

/**
 * Without `force` an existing config is reported, not touched. With `force`
 * the pin is rewritten and a valid `ignore` list preserved; unknown keys or a
 * malformed `ignore` refuse, since overwriting them would lose user data.
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
    await write(configPath, pin);
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
  const ignoreRes = preservedIgnore(configPath, rawRes.raw);
  if (!ignoreRes.ok) return ignoreRes;
  await write(configPath, pin, ignoreRes.ignore);
  return { ok: true, action: "wrote", path: configPath, pin };
}
