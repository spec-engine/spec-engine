// packages/engine/src/onboarding/prompt.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INIT-008
//
// INIT-13: shared interactive onboarding prompt for the 8 indexing-tier
// commands (index, check, map, propagation, query, resolve, gate, serve).
//
// Suppression gate (any one suppresses, all three required for interactive
// path):
//   - args.ci               → explicit CI flag (only `check` registers this)
//   - args.noPrompt         → user opt-out (Plan 10-02 registers on all 8)
//   - !process.stdin.isTTY  → pipes / daemons / redirections
//
// On the interactive path: discoverRepos(platformDir) → for each
// SkippedRepo: y/N via node:readline; y → invoke initCommand.run inline
// (default pin resolution per INIT-13); n/empty/EOF → exit 1 with the
// documented "spec: <name>/ has no spec-engine.member.json — run `spec init
// <name>` first, or re-run non-interactively to skip with a warning" message.
//
// Pitfall 4: rl.close() MUST run in a `finally` block (NOT inside the
// Promise executor) — calling rl.question after rl.close throws in Node's
// readline and hangs the test runner / outer command.
//
// Pitfall 5: pass ONLY `{ repo: s.path }` to initRun. NEVER spread
// opts.args — forwarding --force / --ci / --no-prompt into init would
// trigger wrong code paths or silent data loss.
//
// T-10-03: prompt is rendered to process.stderr (NOT stdout) — keeps
// stdout machine-parseable for --json consumers (mirrors check.ts:99
// which writes the --ci cold-rm notice to stderr for the same reason).
//
// HARD CONSTRAINT (D-08): this file does NOT import bun:sqlite.
// The prompt helper is storage-free (discoverRepos is too).

import { createInterface } from "node:readline";
import { initCommand } from "../commands/init";
import { discoverRepos } from "../indexer/discover";

export interface PromptArgs {
  ci?: boolean;
  noPrompt?: boolean;
}

export interface MaybePromptOpts {
  platformDir: string;
  args: PromptArgs;
}

/**
 * Pre-flight prompt: if interactive AND `discoverRepos` returns non-empty
 * `skipped[]`, prompt the user per sibling. Returns cleanly when nothing
 * to prompt (suppression OR empty skipped) OR every sibling was accepted.
 * Calls `process.exit(1)` directly on `n`/empty/EOF (the contract per
 * INIT-13 — callers do NOT need to read the return value).
 *
 * Iterates the snapshot of skipped[] taken once at entry (no re-walk per
 * `y` — the inline init writes the sibling's config, but the prompt loop
 * does NOT call discoverRepos again; the outer command's own runIndex
 * call re-walks after this helper returns).
 */
export async function maybePromptForOnboarding(opts: MaybePromptOpts): Promise<void> {
  // Suppression gate — three signals, any one suppresses. Order:
  //   1. ci (cheapest — direct flag check)
  //   2. noPrompt (user opt-out)
  //   3. !isTTY (most common — pipes/daemons; property access is cheap
  //      but conceptually the broadest signal)
  if (opts.args.ci) return;
  if (opts.args.noPrompt) return;
  if (!process.stdin.isTTY) return;

  // Discover at entry. Snapshot — no re-walk per `y`.
  const { skipped } = await discoverRepos(opts.platformDir);
  if (skipped.length === 0) return;

  for (const s of skipped) {
    const answer = await askYesNo(
      `${s.name}/ has no spec-engine.member.json — run \`spec init ${s.name}\` now? (y/N) `,
    );
    if (answer === "y") {
      // Inline init — pass ONLY `repo` (Pitfall 5). The init flow's own
      // process.exit(2) paths propagate cleanly: a refused sibling
      // terminates the outer command, which is the desired behavior
      // (silently masking would hide a real error — Pitfall 6).
      type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
      const initRun = (initCommand as unknown as { run: RunFn }).run;
      await initRun({ args: { repo: s.path }, rawArgs: [] });
      continue;
    }
    // n / empty / EOF → exit 1 with the documented INIT-13 message.
    // Prefix is "spec: " (cross-cutting concern — no specific subcommand
    // name; the prompt fires from any of 8 commands).
    console.error(
      `spec: ${s.name}/ has no spec-engine.member.json — run \`spec init ${s.name}\` first, or re-run non-interactively to skip with a warning`,
    );
    process.exit(1);
  }
}

/**
 * Read one line from stdin, return "y" iff the trimmed lowercase answer
 * is exactly "y". Everything else (including "yes", empty, EOF) is "n".
 *
 * Output sent to stderr (T-10-03) — keeps stdout clean for --json consumers.
 *
 * Pitfall 4: rl.close() in `finally`, NEVER inside the Promise executor.
 * Calling rl.question after rl.close throws in Node's readline and hangs
 * the event loop past process.exit calls in Bun under some conditions.
 */
async function askYesNo(question: string): Promise<"y" | "n"> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((res) => rl.question(question, res));
    return answer.trim().toLowerCase() === "y" ? "y" : "n";
  } finally {
    rl.close();
  }
}
