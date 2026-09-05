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
