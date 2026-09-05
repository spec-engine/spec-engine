// packages/engine/src/onboarding/prompt.ts
//
// The interactive onboarding prompt every index-building command runs first.
// It is rendered on stderr so stdout stays machine-parseable, and it passes
// only `{ repo }` to `spec init`, never the outer command's flags.

import { createInterface } from "node:readline";
import { runInit } from "../commands/init";
import { discoverRepos, type NamedDir } from "../indexer/discover";

export interface PromptArgs {
  ci?: boolean | undefined;
  noPrompt?: boolean | undefined;
}

export interface MaybePromptOpts {
  platformDir: string;
  args: PromptArgs;
}

interface Offer extends NamedDir {
  /** Why the directory is offered, as the sentence fragment after its name. */
  why: string;
}

/**
 * Offer `spec init <name>` for each declared member without a pin and for
 * each undeclared repository in the platform folder. Suppressed by `--ci`,
 * `--no-prompt`, or a non-TTY stdin. A refused offer exits 1 with the
 * remediation; an accepted one runs `spec init` inline and moves on. The
 * offers are a snapshot taken once; the outer command rediscovers afterwards.
 * @spec INIT-033
 */
export async function maybePromptForOnboarding(opts: MaybePromptOpts): Promise<void> {
  if (opts.args.ci) return;
  if (opts.args.noPrompt) return;
  if (!process.stdin.isTTY) return;

  const { unpinned, undeclared } = await discoverRepos(opts.platformDir);
  const offers: Offer[] = [
    ...unpinned.map((d) => ({ ...d, why: "has no spec-engine.member.json" })),
    ...undeclared.map((d) => ({ ...d, why: "is not a member of the platform" })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const offer of offers) {
    const answer = await askYesNo(
      `${offer.name}/ ${offer.why} — run \`spec init ${offer.name}\` now? (y/N) `,
    );
    if (answer === "y") {
      await runInit({ repo: offer.path });
      continue;
    }
    console.error(
      `spec: ${offer.name}/ ${offer.why} — run \`spec init ${offer.name}\` first, or re-run non-interactively to skip with a warning`,
    );
    process.exit(1);
  }
}

/** Read one line; "y" iff the trimmed lowercase answer is exactly "y". The interface closes in `finally`. */
async function askYesNo(question: string): Promise<"y" | "n"> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((res) => rl.question(question, res));
    return answer.trim().toLowerCase() === "y" ? "y" : "n";
  } finally {
    rl.close();
  }
}
