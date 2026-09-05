// packages/engine/src/authoring/grammar.ts
//
// Write-time statement-grammar judgment, the authoring half of the
// STATEMENT_GRAMMAR check (check/grammar.ts owns the read half). Only NEW
// statement text is judged; existing statements are the check pass's
// burn-down list, never a write blocker.

import { join } from "node:path";
import { parseEarsStatement } from "@spec-engine/shared";
import { CANONICAL_SPECS_DIR, SPEC_FILENAME } from "../constants";

interface GrammarConfig {
  grammar: "ears" | "freeform";
  severity: "warning" | "error";
}

/** The domain's grammar declaration, defaulting to freeform on any absence
 *  or read failure (structural validation owns malformed files). */
async function grammarConfig(platformDir: string, key: string): Promise<GrammarConfig> {
  try {
    const doc = JSON.parse(
      await Bun.file(join(platformDir, CANONICAL_SPECS_DIR, key, SPEC_FILENAME)).text(),
    ) as { grammar?: unknown; grammarSeverity?: unknown };
    return {
      grammar: doc.grammar === "ears" ? "ears" : "freeform",
      severity: doc.grammarSeverity === "error" ? "error" : "warning",
    };
  } catch {
    return { grammar: "freeform", severity: "warning" };
  }
}

export type GrammarVerdict =
  | { ok: true }
  | { ok: false; severity: "warning" | "error"; key: string; message: string };

/**
 * Judge a to-be-written statement against the domain's declared grammar.
 * Conforming statements, freeform domains, and the TERM domain (definitions,
 * not behavior) are `ok`. A nonconforming statement carries the domain's
 * severity and a message without any command prefix, so each surface can
 * render it as a warning or a refusal.
 * @spec REQ-020
 */
export async function judgeStatementGrammar(
  platformDir: string,
  key: string,
  statement: string,
): Promise<GrammarVerdict> {
  if (key === "TERM") return { ok: true };
  const cfg = await grammarConfig(platformDir, key);
  if (cfg.grammar !== "ears") return { ok: true };
  const result = parseEarsStatement(statement);
  if (result.ok) return { ok: true };
  return {
    ok: false,
    severity: cfg.severity,
    key,
    message:
      `the statement does not match the domain's EARS shape — ${result.problem}.\n` +
      `Expected one of:\n  ${result.expected}`,
  };
}

/** The warning line a surface prints for a nonconforming statement that was written anyway. */
export function grammarWarningText(
  cmdName: string,
  v: Extract<GrammarVerdict, { ok: false }>,
): string {
  return `${cmdName}: ${v.message}\n(warning — written anyway; ${v.key} sets grammar: "ears")`;
}

/** The refusal line a surface prints when the domain's severity is `error`. */
export function grammarRefusalText(
  cmdName: string,
  v: Extract<GrammarVerdict, { ok: false }>,
): string {
  return `${cmdName}: ${v.message}\n(${v.key} sets grammarSeverity: "error", so the write is refused)`;
}
