// packages/engine/src/authoring/grammar.ts
//
// Write-time statement-grammar enforcement — the authoring half of the
// STATEMENT_GRAMMAR check (check/grammar.ts owns the read half). When a
// command is about to write a NEW statement into a domain that declares
// `grammar: "ears"`, the statement is parsed against the five EARS shapes:
//
//   - warning severity (the default): the problem prints to stderr with the
//     expected shapes and the write proceeds — a nudge, not a wall.
//   - error severity: the write is refused (exit 2) — vagueness cannot enter
//     the domain at all.
//
// Only NEW statement text is judged (`--text` on req/amend/supersede/move);
// existing statements are the check pass's burn-down list, never a write
// blocker.

import { join } from "node:path";
import { parseEarsStatement } from "@spec-engine/shared";
import { EXIT } from "../constants";

interface GrammarConfig {
  grammar: "ears" | "freeform";
  severity: "warning" | "error";
}

/** The domain's grammar declaration, defaulting to freeform on any absence
 *  or read failure (structural validation owns malformed files). */
async function grammarConfig(platformDir: string, key: string): Promise<GrammarConfig> {
  try {
    const doc = JSON.parse(
      await Bun.file(join(platformDir, "spec-engine", key, "SPEC.json")).text(),
    ) as { grammar?: unknown; grammarSeverity?: unknown };
    return {
      grammar: doc.grammar === "ears" ? "ears" : "freeform",
      severity: doc.grammarSeverity === "error" ? "error" : "warning",
    };
  } catch {
    return { grammar: "freeform", severity: "warning" };
  }
}

/**
 * Validate a to-be-written statement against the domain's declared grammar.
 * Prints nothing and returns for freeform domains and conforming statements;
 * warns (and returns) or refuses (exit 2) for nonconforming ones, per the
 * domain's `grammarSeverity`. The TERM domain holds definitions, not behavior
 * statements — always exempt.
 * @spec REQ-020
 */
export async function enforceStatementGrammar(
  platformDir: string,
  key: string,
  statement: string,
  cmdName: string,
): Promise<void> {
  if (key === "TERM") return;
  const cfg = await grammarConfig(platformDir, key);
  if (cfg.grammar !== "ears") return;
  const result = parseEarsStatement(statement);
  if (result.ok) return;

  const message =
    `${cmdName}: the statement does not match the domain's EARS shape — ${result.problem}.\n` +
    `Expected one of:\n  ${result.expected}`;
  if (cfg.severity === "error") {
    console.error(`${message}\n(${key} sets grammarSeverity: "error", so the write is refused)`);
    process.exit(EXIT.USAGE);
  }
  console.error(`${message}\n(warning — written anyway; ${key} sets grammar: "ears")`);
}
