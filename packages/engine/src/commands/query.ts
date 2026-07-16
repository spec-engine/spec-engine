// packages/engine/src/commands/query.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec QURY-001
//
// `spec query <text> [platformDir] [--out <path>] [--json] [--limit N]` —
// citty subcommand for FTS5 retrieval over requirement text + why (QURY-01
// / QURY-02). Reads exclusively through `storage.searchFts(text, limit)` —
// which runs FTS_SEARCH_SQL (porter-stemmed bm25, Superseded filter, rank
// ASC). The headline value moment is `spec query "renewal charge"` →
// BILLING-009 as the top hit against the canonical fixture.
//
// Behavior:
//   - Read-only command: never exits non-zero on the data itself. Bad args
//     (empty text, invalid --limit), FTS5 grammar errors, and V12
//     path-containment violations exit 2. Successful execution lets citty
//     fall through to exit 0 (matches commands/map.ts and
//     commands/propagation.ts).
//   - Empty / whitespace-only text: stderr usage message, exit 2.
//   - Invalid --limit (non-integer, ≤ 0, > 1000): stderr message, exit 2.
//     Upper bound of 1000 keeps the query bounded and is high enough that
//     it's never a real-user limitation for a PoC corpus.
//   - If `dbPath` does not exist, transparently runIndex (03-RESEARCH
//     Open Q1 — same resolution as `spec check` / `spec map` /
//     `spec propagation`). If it already exists, reuse it.
//   - FTS5 grammar errors thrown by storage.searchFts (the typed Error
//     whose message starts with `searchFts: FTS5 query syntax error`)
//     are caught and re-emitted as a friendly stderr line, then exit 2.
//     Pitfall 8: never silently swallow.
//   - Output delegated to query/format.ts (pure formatter). Text mode is
//     REQ_ID | RANK | SOURCE | EXCERPT; JSON mode is JSON.stringify(sorted)
//     for byte-stable downstream consumption.
//
// V12 path-containment: if `--out` is supplied, the resolved path MUST
// stay under `resolve(platformDir)`. Same guard as commands/check.ts,
// commands/map.ts, and commands/propagation.ts.
//
// D-08 grep-fence: this file does NOT import bun:sqlite. DB access goes
// exclusively through the Storage interface from @spec-engine/shared.

import { resolve } from "node:path";
import { DEFAULT_QUERY_LIMIT, type FtsHit, LIMIT_MAX } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { EXIT, OUT_HELP, resolveDbPath } from "../constants";
import { formatNoRequirementsIndexed } from "../indexer/discover";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { renderQuery } from "../query/format";
import { assertContainedPath, withReadStorage } from "./_shared";

export const queryCommand = defineCommand({
  meta: {
    name: "query",
    description:
      "FTS5 retrieval over requirement text + why. Default LIMIT 10. Query syntax follows SQLite FTS5 MATCH (wrap phrases in double quotes; literal AND/OR/NOT are operators).",
  },
  args: {
    text: {
      type: "positional",
      required: true,
      description: "FTS5 MATCH query (e.g., 'renewal charge')",
    },
    platformDir: {
      type: "positional",
      required: false,
      description: "Platform directory containing spec-engine/ + members (default: cwd)",
    },
    out: {
      type: "string",
      description: OUT_HELP,
    },
    json: {
      type: "boolean",
      description: "Emit hits as JSON (rank-ascending, no chrome)",
    },
    fresh: {
      type: "boolean",
      description:
        "Force a cold rebuild of the derived index before reading (rm + reindex; same trio as check --ci)",
    },
    limit: {
      type: "string",
      default: String(DEFAULT_QUERY_LIMIT),
      description: `Max result count (positive integer, ≤ ${LIMIT_MAX})`,
    },
    noPrompt: {
      type: "boolean",
      description:
        "Suppress interactive onboarding prompt for siblings missing spec-engine.member.json (defaults to NO_SPEC_CONFIG warning)",
    },
  },
  async run({ args }) {
    const text = ((args.text as string | undefined) ?? "").trim();
    if (!text) {
      console.error('spec query: <text> is required (e.g., spec query "renewal charge")');
      process.exit(EXIT.USAGE);
      return;
    }

    const rawLimit = (args.limit as string | undefined) ?? String(DEFAULT_QUERY_LIMIT);
    // WR-04: strict integer shape — Number.parseInt silently accepts
    // "10abc" (→ 10), "10.5" (→ 10), "10e3" (→ 10). Validate the string
    // shape against /^[1-9][0-9]*$/ so the error message stays faithful
    // to what the parser actually requires.
    if (!/^[1-9][0-9]*$/.test(rawLimit)) {
      console.error(`spec query: --limit must be a positive integer ≤ ${LIMIT_MAX}`);
      process.exit(EXIT.USAGE);
      return;
    }
    const limit = Number.parseInt(rawLimit, 10);
    if (limit > LIMIT_MAX) {
      console.error(`spec query: --limit must be a positive integer ≤ ${LIMIT_MAX}`);
      process.exit(EXIT.USAGE);
      return;
    }

    const platformDir = resolve((args.platformDir as string | undefined) ?? process.cwd());
    const outArg = args.out as string | undefined;
    // WR-01: resolve --out relative to platformDir (NOT cwd); V12
    // path-containment guard — shared with every other --out command.
    const dbPath = resolveDbPath(platformDir, outArg);
    if (outArg) assertContainedPath(dbPath, platformDir, "spec query: --out");

    // INIT-13 pre-flight: interactive prompt for skipped siblings. Runs
    // BEFORE mkdirSync(.spec-engine) so the exit-1 n-path leaves no artefacts.
    // Suppressed in non-TTY / --no-prompt contexts; falls through
    // to NO_SPEC_CONFIG warning per Phase 8 in those cases.
    // WR-01: only `check` registers `--ci`, so `args.ci` would be undefined
    // here — drop the dead plumbing rather than forward `undefined`.
    await maybePromptForOnboarding({
      platformDir,
      args: {
        noPrompt: args.noPrompt as boolean | undefined,
      },
    });

    await withReadStorage({ platformDir, dbPath, fresh: !!args.fresh }, (storage) => {
      let hits: FtsHit[];
      try {
        hits = storage.searchFts(text, limit);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith("searchFts: FTS5 query syntax error")) {
          console.error(
            "spec query: FTS5 query syntax error — try wrapping the phrase in double quotes",
          );
          process.exit(EXIT.USAGE);
          return;
        }
        throw e;
      }
      // RED-11: distinguish "no FTS match for this text" (a normal empty
      // result) from "this platform has no requirements at all" (a
      // brand-new platform that deserves first-spec guidance). Text mode
      // only — JSON consumers depend on "[]" on stdout. Still exit 0.
      if (!args.json && hits.length === 0 && storage.listRequirements().length === 0) {
        console.error(formatNoRequirementsIndexed(platformDir));
        return;
      }
      const output = renderQuery(hits, args.json ? "json" : "text");
      console.log(output);
    });
    // Read-only command: exit 0 unconditionally on success.
  },
});
