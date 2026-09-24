// packages/engine/src/commands/_args.ts
//
// The citty arg specs every command shares, declared once, plus the
// platformDir resolution every command performs.

import { resolve } from "node:path";
import { OUT_HELP } from "../constants";

export const platformDirArg = {
  type: "positional",
  required: false,
  description: "Platform directory containing spec-engine/ (default: cwd)",
} as const;

export const outArg = { type: "string", description: OUT_HELP } as const;

export const jsonArg = {
  type: "boolean",
  description: "Emit JSON on stdout (deterministically sorted, no chrome)",
} as const;

export const freshArg = {
  type: "boolean",
  description: "Force a cold rebuild of the derived index before reading (rm + reindex)",
} as const;

export const noPromptArg = {
  type: "boolean",
  description:
    "Suppress the interactive onboarding prompt for siblings missing spec-engine.member.json (they surface as NO_SPEC_CONFIG warnings)",
} as const;

/** The absolute platform directory: the positional, else the process cwd. */
export function resolvePlatformDir(args: { platformDir?: string | undefined }): string {
  return resolve(args.platformDir ?? process.cwd());
}

export const livesArg = {
  type: "string",
  description:
    "Lives in (livesIn) paths: repeat the flag or comma-separate; an empty value clears the list",
} as const;

/**
 * Every value a repeatable list flag carried, each split on commas, trimmed,
 * empties dropped. citty keeps only the last occurrence of a repeated flag, so
 * `rawArgs` is read first; `parsed` covers an in-process call that passes no
 * raw argv. Undefined when the flag is absent.
 * @spec REQ-042
 */
export function listFlag(
  rawArgs: readonly string[],
  name: string,
  parsed: string | undefined,
): string[] | undefined {
  const flag = `--${name}`;
  const raw: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i] as string;
    if (arg === flag && i + 1 < rawArgs.length) raw.push(rawArgs[++i] as string);
    else if (arg.startsWith(`${flag}=`)) raw.push(arg.slice(flag.length + 1));
  }
  if (raw.length === 0) {
    if (parsed === undefined) return undefined;
    raw.push(parsed);
  }
  return raw
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v !== "");
}
