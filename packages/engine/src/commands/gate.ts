// packages/engine/src/commands/gate.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec GATE-006
//
// `spec gate <repo> <reqId> [platformDir] [--out <path>] [--json]` —
// citty subcommand for the rung-3 approval primitive (GATE-01 / GATE-02 /
// GATE-03 / GATE-04). Composes around `classifyGate` (the pure decision
// engine from plan 06-02) and `renderGate` (the pure formatter from
// plan 06-03 Task 1); never duplicates decision logic at the CLI seam.
//
// Behavior:
//   - Cold rebuild is UNCONDITIONAL per GATE-03 ("correctness over
//     cache"). For every invocation we coldResetDb(dbPath) — an
//     IN-PLACE, inode-preserving wipe of every user object — BEFORE
//     `openStorage` is called. No `--ci` flag, no `--no-reindex`
//     opt-out, no env-var bypass — a stale DB cannot mask a spec
//     mutation. Mirrors `commands/check.ts --ci` but WITHOUT the outer
//     cold-flag guard — the gate never re-uses a prior index.
//   - After the cold reset, `openStorage(dbPath)` then `runIndex({
//     platformDir, storage})` populates the DB from the spec + tags
//     before the classifier reads anything.
//   - Unknown repo screen (Pitfall 8): if `storage.getRepo(repo)`
//     returns null, write "unknown repo \"<repo>\"" to stderr and
//     exit 2. NEVER call `classifyGate` with a null repo — the
//     classifier throws by contract, and we want the user to see a
//     clean "no such repo" diagnostic rather than a wrapped throw
//     message. Reserves NOT_FOUND exclusively for the requirement-
//     missing path.
//   - Empty/whitespace `repo` or `reqId` exits 2 with a stderr
//     usage message (mirrors propagation.ts:71-78).
//   - Output: text or JSON (GATE-04). The formatter (gate/format.ts)
//     owns serialization shape.
//   - Exit codes:
//       0 — PASS (outcome.pass === true)
//       1 — any gate failure (NOT_FOUND, DRAFT, SUPERSEDED, VERSION_PIN)
//       2 — command crash, bad args, path-containment violation, or
//           unknown repo
//
// V12 path-containment (T-06-03-01): if `--out` is supplied, the
// resolved path MUST stay under `resolve(platformDir)`. Same guard
// pattern as `commands/check.ts:73-83` and `commands/propagation.ts:
// 88-97`. Defense against `--out ../../etc/passwd` and friends.
//
// Lifecycle (Pitfall 7): `storage.close()` MUST run BEFORE
// `process.exit(N)`. Bun's `process.exit` terminates synchronously and
// skips pending `finally` blocks, so the close-then-exit ordering is
// mandatory at every exit site.
//
// D-08 grep-fence: this file does NOT import bun:sqlite. DB access
// goes exclusively through the Storage interface from @spec-engine/shared.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { GateOutcome } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { EXIT, OUT_HELP, resolveDbPath } from "../constants";
import { classifyGate } from "../gate/classify";
import { renderGate } from "../gate/format";
import { formatNotASpecPlatform } from "../indexer/discover";
import { runIndex } from "../indexer/pipeline";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { openStorage } from "../storage/sqlite";
import { assertContainedPath, coldResetDb } from "./_shared";

// WR-03: identify broken-pipe write failures so a piped member that
// closes stdout early (e.g., `spec gate ... | head -1`, `... | jq -r
// .reason`) does not cause `spec gate` to exit 2 ("crashed") despite
// the member having already received the decision bytes it asked for.
// Node/Bun surface broken-pipe as `EPIPE` on the error object's `code`
// field; some runtimes also surface it as `ERR_STREAM_DESTROYED`. Match
// both shapes defensively.
function isEpipe(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  const code = (e as { code?: unknown }).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

// Raw citty positional/flag shape read by the extracted stages. All fields
// are optional/unknown so the validated `{ repo, reqId, platformDir }` only
// leaves resolveGateArgs after the empty-arg / not-a-platform guards below.
interface GateRawArgs {
  repo?: unknown;
  reqId?: unknown;
  platformDir?: unknown;
  out?: unknown;
  json?: unknown;
  noPrompt?: unknown;
}

// The validated argv triple the run handler consumes after stage (a).
interface GateArgs {
  repo: string;
  reqId: string;
  platformDir: string;
}

// Stage (a) — arg validation. Trims the positionals, screens for an empty
// repo/reqId or a non-platform dir, and emits the advisory manifest warning,
// returning the validated triple. Every failure exits 2 BEFORE any FS write
// or DB work; because Bun/citty `process.exit` is `never` (and the test
// harness throws from its stub) control never falls through a guard.
function resolveGateArgs(args: GateRawArgs): GateArgs {
  // T-06-03-04: trim + non-empty guard. Empty/whitespace positionals
  // would otherwise flow into storage.getRepo($name) / getRequirement
  // ($id) as the literal "", which returns null and gets routed to
  // "unknown repo" — but that conflates "you forgot to supply a repo"
  // with "you typed a repo that doesn't exist". Surface argv error as
  // exit 2 BEFORE any DB work.
  const repo = ((args.repo as string | undefined) ?? "").trim();
  const reqId = ((args.reqId as string | undefined) ?? "").trim();
  if (!repo || !reqId) {
    console.error("spec gate: <repo> and <reqId> are required (e.g., spec gate api BILLING-009)");
    process.exit(EXIT.USAGE);
  }

  const platformDir = resolve((args.platformDir as string | undefined) ?? process.cwd());

  // WR-04 / WR-05 / WR-06: validate platformDir up front, BEFORE any FS
  // write (mkdirSync or the unconditional cold reset). Without this,
  // running `spec gate` from an arbitrary cwd would mint a stray
  // `<cwd>/.spec-engine/` directory in any path the user happens to be in, and
  // the cold reset would wipe a pre-existing `<cwd>/.spec-engine/index.
  // sqlite` in a sibling project.
  //
  // WR-05/WR-06: the canonical platform anchor that every other Spec Engine
  // command agrees on is the `spec-engine/` directory (mandatory in
  // `discoverRepos`). The gate uses ONLY that directory check as the
  // admission gate, consistent with the rest of the toolchain. (RED-85: the
  // old spec-engine.platform.json missing-manifest advisory is gone — the
  // manifest is retired; the platform version is derived from the domain
  // SPEC.json files inside `discoverRepos`.) The iter-2 WR-05 footgun (a
  // stray spec-engine/ subdirectory in an unrelated cwd) is mitigated by the
  // same directory check the rest of the indexer relies on; the cold reset
  // remains scoped to `<platformDir>/.spec-engine/` regardless.
  const hasSpecEngineDir = existsSync(join(platformDir, "spec-engine"));
  if (!hasSpecEngineDir) {
    // RED-11: same friendly first-spec guidance as the other command
    // boundaries (map/check/index/query/resolve/propagation/serve)
    // instead of the old bespoke one-liner. Still exit 2.
    console.error(formatNotASpecPlatform(platformDir));
    process.exit(EXIT.USAGE);
  }

  return { repo, reqId, platformDir };
}

// Stage (b) — pre-flight. Resolves the DB path, enforces the path-containment
// guard, runs the onboarding prompt, mkdirs the index dir, and performs the
// UNCONDITIONAL cold reset so no exit path leaves a partial DB. Returns the
// resolved dbPath for the storage lifecycle.
async function preflightGate(args: GateRawArgs, platformDir: string): Promise<string> {
  const outArg = args.out as string | undefined;
  // WR-01: resolve --out relative to platformDir (NOT cwd). Mirrors
  // commands/check.ts:69-71 and commands/propagation.ts:84-86.
  const dbPath = resolveDbPath(platformDir, outArg);

  // T-06-03-01: V12 path-containment. Mirrors commands/check.ts:73-83
  // and commands/propagation.ts:88-97 verbatim (substituting "spec
  // gate" in the error message). Runs BEFORE the cold reset so a
  // hostile --out cannot rm a file outside the workspace.
  if (outArg) assertContainedPath(dbPath, platformDir, "spec gate: --out");

  // INIT-13 pre-flight: interactive prompt for skipped siblings. Runs
  // BEFORE mkdirSync(.spec-engine) AND BEFORE the unconditional cold reset
  // below so the exit-1 n-path leaves no artefacts and no partially-
  // removed DB. Suppressed in non-TTY / --no-prompt contexts;
  // falls through to NO_SPEC_CONFIG warning per Phase 8 in those cases.
  // WR-01: only `check` registers `--ci`, so `args.ci` would be undefined
  // here — drop the dead plumbing rather than forward `undefined`.
  await maybePromptForOnboarding({
    platformDir,
    args: {
      noPrompt: args.noPrompt as boolean | undefined,
    },
  });

  mkdirSync(dirname(dbPath), { recursive: true });

  // T-06-03-03 / GATE-03: the cold reset is UNCONDITIONAL. No cold-flag
  // outer guard, no `--no-reindex` opt-out — every invocation starts
  // from a fresh derivation so a stale index cannot mask a spec mutation.
  // coldResetDb wipes IN PLACE (inode-preserving — a concurrent `spec
  // serve` reader on this file never ghosts onto an unlinked inode) and
  // handles the missing-file / corrupt-file cases internally, so the WR-01
  // TOCTOU concern (a concurrent process deleting the file mid-reset)
  // stays covered by its rmDbTrio fallback path.
  coldResetDb(dbPath);
  // Log to stderr so --json stdout stays clean for jq parsing.
  console.error("spec gate: cold-reset prior index state (in place)");

  return dbPath;
}

// Stage (c) — WR-03 EPIPE-tolerant stdout write. A member pipeline like
// `spec gate ... | head -1` closes the read end after the first line, and the
// next write throws EPIPE. The outer catch would then surface that as
// `crashed: write EPIPE` exit 2, even though the member already received
// what they asked for and the gate decision itself succeeded. Worse, a
// successful FAIL JSON write followed by an EPIPE on the build_id tail line
// would cause caller and gate to disagree about whether the gate ran (member
// sees outcome and exits 0; gate exits 2). Treat EPIPE on stdout writes as
// "consumer got the bytes they wanted" and continue to the pass/fail exit path.
function writeStdoutTolerant(line: string): void {
  try {
    console.log(line);
  } catch (writeErr) {
    if (!isEpipe(writeErr)) throw writeErr;
  }
}

export const gateCommand = defineCommand({
  meta: {
    name: "gate",
    description:
      "Rung-3 approval primitive: passes iff <reqId> is Active and <repo>'s pinned spec_version covers its changed_at_version. Exits 0 PASS / 1 any gate failure / 2 crash or bad args.",
  },
  args: {
    repo: {
      type: "positional",
      required: true,
      description: "Member repo name (e.g., api, mobile, admin)",
    },
    reqId: {
      type: "positional",
      required: true,
      description: "Target requirement id (e.g., BILLING-009)",
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
      description: "Emit outcome as a JSON object (no chrome, byte-stable)",
    },
    noPrompt: {
      type: "boolean",
      description:
        "Suppress interactive onboarding prompt for siblings missing spec-engine.member.json (defaults to NO_SPEC_CONFIG warning)",
    },
  },
  async run({ args }) {
    // Stage (a): trim + non-empty guard, platformDir resolve, spec-engine/
    // admission, and the advisory manifest warning — all BEFORE any DB work.
    // Every failure exits 2 inside (see resolveGateArgs for the guarded invariants).
    const { repo, reqId, platformDir } = resolveGateArgs(args);

    // Stage (b): resolve dbPath, path-containment, onboarding prompt, mkdir,
    // and the UNCONDITIONAL cold reset (coldResetDb) (see preflightGate for invariants).
    const dbPath = await preflightGate(args, platformDir);

    // WR-05 / Pitfall 7: wrap the storage lifecycle in try/catch so any
    // crash inside openStorage / runIndex / classifyGate / renderGate
    // surfaces as exit code 2 ("command crash"), not as citty's default
    // uncaught-exception handling (which would map to exit 1 — colliding
    // with the gate-failure exit code). storage.close() MUST precede
    // process.exit at every exit site because Bun's process.exit skips
    // finally blocks.
    let storage: ReturnType<typeof openStorage> | undefined;
    let outcome: GateOutcome | undefined;
    try {
      storage = openStorage(dbPath);
      const result = await runIndex({ platformDir, storage });
      const req = storage.getRequirement(reqId);
      const repoRow = storage.getRepo(repo);

      // T-06-03-05 / Pitfall 8: unknown-repo screen. MUST run BEFORE
      // classifyGate, which throws by contract on null repo. We want
      // the user to see a clean "no such repo" diagnostic, NOT a
      // wrapped throw message — and we want NOT_FOUND reserved for the
      // requirement-missing path.
      if (repoRow === null) {
        console.error(`spec gate: unknown repo "${repo}"`);
        try {
          storage.close();
        } catch {
          // Closing a half-broken DB can itself throw; already exiting 2.
        }
        process.exit(EXIT.USAGE);
        return;
      }

      outcome = classifyGate({
        req,
        repo: repoRow,
        requestedRepoName: repo,
        requestedReqId: reqId,
      });
      const output = renderGate(outcome, args.json ? "json" : "text");
      // Tolerate broken-pipe on the decision line and the build_id tail via
      // writeStdoutTolerant (see its header for the full pipe-member rationale).
      writeStdoutTolerant(output);

      // Text mode appends a build_id tail line (parity with check.ts:
      // 123-124). JSON mode emits ONLY the GateOutcome object on stdout
      // so jq / scripts get byte-stable single-line input.
      if (!args.json) {
        writeStdoutTolerant(`build_id: ${result.build_id}`);
      }
    } catch (e) {
      try {
        storage?.close();
      } catch {
        // Closing a half-broken DB can itself throw; we are already
        // exiting 2 — swallow the secondary failure so the original
        // crash reason is what the user sees.
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`spec gate: crashed: ${msg}`);
      process.exit(EXIT.USAGE);
      return;
    }

    // WR-02: explicit narrowing guard. `outcome` is declared `GateOutcome
    // | undefined` and is only assigned inside the try block. Every
    // non-assigning path inside that block exits via `process.exit(2)` or
    // rethrows, so by construction `outcome` is defined here — but TS
    // can't see that, and the invariant is fragile: a future no-throw
    // early `return` inside the try block, or a test stub that replaces
    // `process.exit` with a non-throwing fake, would let execution fall
    // through and `outcome.pass` would throw TypeError. That would
    // surface as exit 1 via citty's default uncaught-exception handling
    // — directly colliding with the gate-failure exit code (the whole
    // reason exit 2 exists is to keep crash and gate-failure distinct).
    // Fail loudly with exit 2 if the unreachable case ever triggers.
    if (!outcome) {
      console.error("spec gate: internal error — outcome never assigned");
      try {
        storage?.close();
      } catch {
        // already exiting 2; swallow secondary failure
      }
      process.exit(EXIT.USAGE);
      return;
    }
    // Close storage BEFORE process.exit so the DB file handle releases
    // cleanly. Bun's process.exit terminates synchronously and skips
    // pending finally blocks (Pitfall 7).
    storage.close();
    // 0 = PASS, 1 = any gate failure (NOT_FOUND / DRAFT / SUPERSEDED /
    // VERSION_PIN). The classifier sets outcome.pass === true ONLY for
    // the PASS reason.
    process.exit(outcome.pass ? EXIT.OK : EXIT.FAILURE);
  },
});
