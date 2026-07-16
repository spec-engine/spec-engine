// packages/engine/src/commands/resolve.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec RSLV-001
//
// `spec resolve <files...> [platformDir] [--out <path>] [--json]` — citty
// subcommand that returns the requirements tagged in the given files (one
// DISTINCT join over `tags.file IN (...)`, RSLV-01 / RSLV-02). Reads
// exclusively through `storage.resolveByFiles(files)` — the storage seam
// that already orders rows by `(key, seq)` ascending. The headline value
// moment is `spec resolve api/src/renew.ts api/src/charge.ts --json` →
// `[BILLING-002, BILLING-009]` against the canonical fixture.
//
// Behavior:
//   - Read-only command: never exits non-zero on the data itself. Bad args
//     (no file positionals, file outside platformDir, V12 --out violation)
//     exit 2. Successful execution lets citty fall through to exit 0
//     (matches commands/query.ts and commands/propagation.ts).
//   - Multi-file inputs: citty's `type: "positional"` binds ONE slot per
//     declared name (Pitfall 2 in 05-RESEARCH). We collect the full
//     positional set out of `rawArgs`, stripping the `--out` /
//     `--platformDir` value-bearing flags and the `--json` boolean.
//   - Comma-split fallback: a single positional containing `,` is split
//     on comma so `spec resolve a.ts,b.ts` matches `spec resolve a.ts
//     b.ts`. Documented in --help.
//   - Path normalization (Pitfall 1): `tags.file` is platform-relative
//     (e.g. `api/src/renew.ts`). Every user input is normalized via
//     `relative(platformDir, resolve(platformDir, input))`; any input
//     whose normalized form starts with `..` is rejected with exit 2 —
//     it would never match the IN-clause and silently return [].
//   - If `dbPath` does not exist, transparently runIndex (matches
//     `spec check` / `spec map` / `spec propagation` / `spec query`).
//   - Output delegated to resolve/format.ts (pure formatter). Text mode
//     is REQ_ID | STATUS | TEXT; JSON mode is JSON.stringify(sorted) for
//     byte-stable downstream consumption.
//
// V12 path-containment: if `--out` is supplied, the resolved path MUST
// stay under `resolve(platformDir)`. Same guard as commands/check.ts,
// commands/map.ts, commands/propagation.ts, and commands/query.ts.
//
// D-08 grep-fence: this file does NOT import bun:sqlite. DB access goes
// exclusively through the Storage interface from @spec-engine/shared.

import { statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { FILES_MAX } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { EXIT, isExistingDir, OUT_HELP, resolveDbPath } from "../constants";
import { formatNoRequirementsIndexed } from "../indexer/discover";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { renderReqTags, renderResolve } from "../resolve/format";
import { assertContainedPath, withReadStorage } from "./_shared";

// Value-bearing flags that consume the next argv slot. The `--json` boolean
// does NOT consume a value. `--platformDir` is documented as a positional
// in the plan but may also be supplied as `--platformDir <dir>` at the
// raw-argv level (citty harness passes the parsed value through `args`
// regardless), so we strip it here defensively.
// T8: `--req` consumes a value slot too — without it the requirement id
// would land as a phantom file positional on the real argv.
const VALUE_FLAGS = new Set(["--out", "-o", "--platformDir", "--req"]);

// FILES_MAX (WR-02 iter1 / WR-01 iter3): the cap on file inputs is shared
// with server/api.ts and storage/sqlite.ts via @spec-engine/shared. A future bump
// (e.g. 1000 → 5000) only touches @spec-engine/shared so all three layers move
// in lockstep.

/** How the argv walker should treat one raw token. */
type ArgKind = "push" | "skip" | "consume-next";

/**
 * Classify one raw argv token for {@link extractPositionals}. Pure — no state.
 *   - `--flag` / `--flag=value` → `skip`, EXCEPT a VALUE_FLAGS long flag in the
 *     bare `--flag value` form (no inline `=`), which is `consume-next` so the
 *     following slot (its value) is dropped too. The `--flag=value` inline form
 *     carries its own value and consumes nothing.
 *   - `-o` short value-flag → `consume-next`; any other short flag → `skip`.
 *   - anything else → `push` (a bare positional).
 */
function classifyArg(a: string): ArgKind {
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    return VALUE_FLAGS.has(name) && eq === -1 ? "consume-next" : "skip";
  }
  if (a.startsWith("-") && a.length > 1) {
    return VALUE_FLAGS.has(a) ? "consume-next" : "skip";
  }
  return "push";
}

/**
 * Extract all bare positional values from `rawArgs`, stripping the known
 * value-bearing flags + their consumed value slots and the boolean flags.
 * Returns the positionals in argv order. Pure helper — no FS, no citty.
 */
function extractPositionals(rawArgs: string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i] ?? "";
    const kind = classifyArg(a);
    if (kind === "consume-next") i += 1;
    else if (kind === "push") positionals.push(a);
  }
  return positionals;
}

/**
 * Decide which rawArgs positional is the platformDir vs which are files.
 *
 * Citty declares two positionals (`files`, `platformDir`) and greedily
 * binds slot 2 of rawArgs to `args.platformDir`. With 3+ positionals
 * (the documented `spec resolve <f1> <f2> <platformDir>` shape) that
 * binding is WRONG — slot 2 is a file, and slot N (the last) is the
 * platformDir. This helper re-derives the correct split using a single
 * stat() check on the last positional.
 *
 * Rule:
 *   - 0 positionals  → files=[], platformDir=undefined (citty rejects req'd)
 *   - 1 positional   → files=[p0], platformDir=undefined (uses cwd)
 *   - 2+ positionals → check whether the LAST positional is an existing
 *     directory. If yes, treat the last as platformDir and all preceding
 *     as files. If no, treat all positionals as files and fall back to
 *     args.platformDir / cwd (same as 1-positional path).
 *
 * This makes both invocation forms work:
 *   spec resolve a.ts,b.ts platformDir/        # 2 positionals
 *   spec resolve a.ts b.ts platformDir/        # 3 positionals
 *   spec resolve a.ts                          # 1 positional, cwd default
 */
function splitFilesAndPlatformDir(
  positionals: string[],
  fallbackPlatformDir: string | undefined,
): { files: string[]; platformDir: string | undefined } {
  if (positionals.length === 0) {
    return { files: [], platformDir: fallbackPlatformDir };
  }
  if (positionals.length === 1) {
    return { files: positionals, platformDir: fallbackPlatformDir };
  }
  const last = positionals[positionals.length - 1] ?? "";
  // A path is a platformDir iff it resolves to a directory AND contains
  // a `spec-engine/` subdirectory (the canonical invariant enforced by
  // `discoverRepos`). The spec-engine check disambiguates against
  // unrelated directories that may exist at the same path under cwd.
  //
  // WR-04: if the last positional resolves to a directory that does NOT
  // contain spec-engine/, the previous behaviour silently misclassified
  // it as a file — the SQL IN-clause then returned [] and the user saw
  // an empty result with no diagnostic. Emit a stderr warning in that
  // case so the misparse is at least visible.
  let lastIsPlatformDir = false;
  let lastIsDirWithoutSpecEngine = false;
  try {
    const resolved = resolve(last);
    if (statSync(resolved).isDirectory()) {
      try {
        if (statSync(join(resolved, "spec-engine")).isDirectory()) {
          lastIsPlatformDir = true;
        } else {
          lastIsDirWithoutSpecEngine = true;
        }
      } catch {
        lastIsDirWithoutSpecEngine = true;
      }
    }
  } catch {
    lastIsPlatformDir = false;
  }
  if (lastIsPlatformDir) {
    return {
      files: positionals.slice(0, -1),
      platformDir: last,
    };
  }
  if (lastIsDirWithoutSpecEngine) {
    console.error(
      `spec resolve: ${last} is a directory but contains no spec-engine/; ` +
        "treating as file (use --platformDir to disambiguate)",
    );
  }
  return { files: positionals, platformDir: fallbackPlatformDir };
}

/**
 * Split every value on `,` and trim each piece; drop empties (WR-03). The
 * one and only place comma-split lives. Before this refactor three copies
 * of this logic existed across `collectPositionalFiles` and the run
 * handler — keeping them in sync was a known maintenance hazard.
 *
 * Supports `spec resolve a.ts,b.ts` matching `spec resolve a.ts b.ts`
 * and the mixed shape `spec resolve a.ts b.ts,c.ts`.
 */
function commaSplit(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    for (const piece of v.split(",")) {
      const t = piece.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * T8 reverse query: list every tag site for `reqId`. Shares the read-only
 * command conventions with the files mode (platform guard before any FS
 * write, --out containment, onboarding prompt, transparent re-index, exit 0
 * on empty results).
 */
interface ReverseQueryOptions {
  reqId: string;
  platformDir: string;
  outArg: string | undefined;
  json: boolean;
  fresh: boolean;
  noPrompt: boolean | undefined;
}

async function runReverseQuery(opts: ReverseQueryOptions): Promise<void> {
  const { reqId, platformDir, outArg, json, fresh, noPrompt } = opts;
  const dbPath = resolveDbPath(platformDir, outArg);

  // V12 path-containment guard — same shape as the files mode below.
  if (outArg) assertContainedPath(dbPath, platformDir, "spec resolve: --out");

  await maybePromptForOnboarding({ platformDir, args: { noPrompt } });

  await withReadStorage({ platformDir, dbPath, fresh }, (storage) => {
    // Strip the AUTOINCREMENT id — an index implementation detail, not part
    // of the CLI contract.
    const rows = storage
      .listTags({ req_id: reqId })
      .map(({ req_id, repo, file, line, kind, level }) => ({
        req_id,
        repo,
        file,
        line,
        kind: kind as string,
        level: (level ?? null) as string | null,
      }));
    if (rows.length === 0) {
      // Guidance on stderr (stdout stays machine-parseable: `[]` / "").
      if (storage.getRequirement(reqId) === null) {
        console.error(`spec resolve: no requirement ${reqId} in the index`);
      } else {
        console.error(`spec resolve: ${reqId} has no tags in any member repo`);
      }
    }
    console.log(renderReqTags(rows, json ? "json" : "text"));
  });
  // Read-only command: exit 0 unconditionally on success.
}

/** The resolved argument shape the run handler orchestrates over: the
 *  comma-split file list, the derived platformDir, and the raw signals the
 *  --req reverse-query path needs (the extracted positionals + the citty-bound
 *  platformDir field). */
interface ResolvedFileArgs {
  files: string[];
  platformDir: string | undefined;
  positionals: string[];
  rawPD: string | undefined;
}

/**
 * Re-split rawArgs positionals into (files, platformDir) using a directory
 * stat on the last positional. Citty's default binding (slot 2 → platformDir)
 * is wrong when the user passes `<f1> <f2> ... <platformDir>` — a 3+ positional
 * shape the command's --help and the plan both document as canonical.
 *
 * Falls back to the citty-parsed args.platformDir when the rawArgs path is
 * empty (in-process test harness) OR when the last positional is not an
 * existing directory (treat all positionals as files; platformDir falls
 * through to args.platformDir / cwd).
 */
function resolveFileArgs(
  args: Record<string, unknown>,
  rawArgs: string[] | undefined,
): ResolvedFileArgs {
  const positionals = extractPositionals(rawArgs ?? []);
  // CR-01 (iter3): the iter2 `sawExplicitPlatformDirFlag` gate broke the
  // in-process test harness (6/10 cli-resolve-unit tests failed) because
  // the harness sets `args.platformDir` directly without threading a
  // literal `--platformDir=…` token through rawArgs. The original WR-01
  // (iter2) concern — citty greedily binding positional slot 1 to
  // `args.platformDir` for `spec resolve a.ts b.ts` — is detectable by
  // a different signal: in that misbinding case, `args.platformDir` IS
  // one of the rawArgs positionals (citty just lifted slot 1). Trust
  // `args.platformDir` when it did NOT come from a positional slot:
  //   - rawArgs empty (pure in-process call), OR
  //   - the value does not appear among the extracted positionals (set
  //     via `--platformDir` flag or direct in-process args field).
  // When citty misbound a positional, `args.platformDir` matches one of
  // the positionals; drop it and let `splitFilesAndPlatformDir`'s
  // last-positional + spec-engine/ stat decide.
  const rawPD = args.platformDir as string | undefined;
  const fallbackPD =
    rawPD === undefined
      ? undefined
      : (rawArgs ?? []).length === 0 || !positionals.includes(rawPD)
        ? rawPD
        : undefined;
  const split = splitFilesAndPlatformDir(positionals, fallbackPD);

  // WR-03: single argv walker (extractPositionals) → split files vs
  // platformDir → commaSplit once. The args.files fallback only kicks
  // in when the rawArgs path is empty (in-process test harness passes
  // args directly without rawArgs).
  let rawFiles: string[];
  if (positionals.length === 0) {
    const first = args.files as string | undefined;
    rawFiles = first ? [first] : [];
  } else {
    rawFiles = split.files;
  }
  return { files: commaSplit(rawFiles), platformDir: split.platformDir, positionals, rawPD };
}

/**
 * T8 reverse-query mode: `--req KEY-NNN` maps a requirement to its tag sites.
 * It takes NO file positionals — the only allowed positional is the platform
 * dir. In-process callers set args.platformDir directly; on the real argv
 * citty binds a lone positional to args.files, so a single "file" that is the
 * platform dir is re-interpreted here. Validates the id (exit 2 on malformed),
 * rejects mixed file paths (exit 2), then delegates to {@link runReverseQuery}.
 */
async function dispatchReverseQuery(
  reqArg: string,
  resolved: ResolvedFileArgs,
  args: Record<string, unknown>,
): Promise<void> {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(reqArg)) {
    console.error(`spec resolve: --req must be a requirement id (KEY-NNN); got ${reqArg}`);
    process.exit(EXIT.USAGE);
  }
  // Collect candidate positionals: rawArgs positionals when present,
  // else the citty-bound fields (in-process harness path).
  const { positionals, rawPD } = resolved;
  const posnl =
    positionals.length > 0
      ? positionals
      : [args.files as string | undefined, rawPD].filter((x): x is string => typeof x === "string");
  // At most ONE positional, and it must be a directory (the platform
  // dir) — anything else means the caller mixed --req with file paths.
  const lone = posnl[0];
  // Defensive swallow: a user-supplied positional may be an odd path;
  // a hard stat failure (EACCES/ELOOP) here means "not the platform dir",
  // not a crash — unlike the discover/onboarding callers that let it throw.
  const loneIsDir =
    lone !== undefined &&
    (() => {
      try {
        return isExistingDir(lone);
      } catch {
        return false;
      }
    })();
  if (posnl.length > 1 || (lone !== undefined && !loneIsDir)) {
    console.error(
      "spec resolve: --req takes no file paths — it lists the files tagging the requirement. Pass at most a platform directory.",
    );
    process.exit(EXIT.USAGE);
  }
  await runReverseQuery({
    reqId: reqArg,
    platformDir: resolve(lone ?? process.cwd()),
    outArg: args.out as string | undefined,
    json: Boolean(args.json),
    fresh: Boolean(args.fresh),
    noPrompt: args.noPrompt as boolean | undefined,
  });
}

/**
 * Normalize each input to platform-relative (Pitfall 1: tags.file is
 * platform-relative, e.g. `api/src/renew.ts`). Absolute paths get re-rooted
 * against platformDir; paths above platformDir are rejected (V12-style guard
 * on file inputs — they would never match the IN-clause and would silently
 * return [], which is a confusing UX).
 */
function normalizeFileInputs(files: string[], platformDir: string): string[] {
  const normalized: string[] = [];
  for (const input of files) {
    const rel = relative(platformDir, resolve(platformDir, input));
    // WR-03 (iter2): compare the first path SEGMENT against `..` instead
    // of substring `rel.startsWith("..")` — the same fix iter1 applied to
    // /api/resolve (api.ts hasTraversalSegment). Substring rejection
    // over-rejects legitimate filenames like `..foo.ts` that resolve under
    // platformDir. Empty / `.` still means "platformDir itself" → reject.
    const segments = rel.split(sep);
    if (rel === "" || rel === "." || segments[0] === "..") {
      console.error(`spec resolve: file path must be inside platformDir: ${input}`);
      process.exit(EXIT.USAGE);
    }
    normalized.push(rel);
  }
  return normalized;
}

export const resolveCommand = defineCommand({
  meta: {
    name: "resolve",
    description:
      "Return the requirements tagged in the given files (RSLV-01). Accepts multiple positional file paths (e.g. `spec resolve api/src/renew.ts api/src/charge.ts`) and a comma-split fallback inside a single positional (`spec resolve a.ts,b.ts`). Paths may be platform-relative or absolute under the platform tree.",
  },
  args: {
    files: {
      type: "positional",
      required: true,
      description:
        "One or more file paths (platform-relative or absolute; comma-split also accepted in a single positional)",
    },
    platformDir: {
      type: "positional",
      required: false,
      description: "Platform directory containing spec-engine/ + members (default: cwd)",
    },
    req: {
      type: "string",
      description:
        "Reverse query (T8): list every tag site (repo, file, line, kind, level) for the given requirement id instead of resolving files. Takes no file positionals.",
    },
    out: {
      type: "string",
      description: OUT_HELP,
    },
    json: {
      type: "boolean",
      description: "Emit requirements as JSON (deterministically sorted, no chrome)",
    },
    fresh: {
      type: "boolean",
      description:
        "Force a cold rebuild of the derived index before reading (rm + reindex; same trio as check --ci)",
    },
    noPrompt: {
      type: "boolean",
      description:
        "Suppress interactive onboarding prompt for siblings missing spec-engine.member.json (defaults to NO_SPEC_CONFIG warning)",
    },
  },
  async run({ args, rawArgs }) {
    // Re-split rawArgs into (files, platformDir), apply the CR-01/WR-01
    // fallback, and comma-split into the final file list (all inside
    // resolveFileArgs); the returned positionals/rawPD feed the --req path.
    const resolved = resolveFileArgs(args, rawArgs);
    const { files } = resolved;

    // T8 reverse-query mode: `--req KEY-NNN` maps a requirement to its tag
    // sites. It takes NO file positionals — dispatchReverseQuery owns the
    // id validation, the mixed-path rejection, and the runReverseQuery call.
    const reqArg = args.req as string | undefined;
    if (reqArg !== undefined) {
      await dispatchReverseQuery(reqArg, resolved, args);
      return;
    }

    if (files.length === 0) {
      console.error(
        "spec resolve: at least one file path required (e.g., spec resolve api/src/renew.ts)",
      );
      process.exit(EXIT.USAGE);
      return;
    }

    // WR-02: cap the files array length so a misuse like `spec resolve
    // $(huge-shell-expansion)` cannot blow past SQLITE_MAX_VARIABLE_NUMBER
    // (32766) downstream in storage.resolveByFiles. Mirrors the same cap
    // enforced at the HTTP seam (server/api.ts FILES_MAX).
    if (files.length > FILES_MAX) {
      console.error(
        `spec resolve: too many files (max ${FILES_MAX} per invocation; got ${files.length})`,
      );
      process.exit(EXIT.USAGE);
      return;
    }

    const platformDir = resolve(resolved.platformDir ?? process.cwd());
    const outArg = args.out as string | undefined;
    // WR-01: resolve --out relative to platformDir (NOT cwd) — mirrors
    // commands/check.ts, commands/map.ts, commands/propagation.ts, and
    // commands/query.ts.
    const dbPath = resolveDbPath(platformDir, outArg);

    // V12 path-containment guard — mirrors commands/query.ts:113-121.
    //
    // WR-03 (iter3): the guard is unconditional. The default-path branch
    // (`join(platformDir, ".spec-engine", "index.sqlite")`) is trivially contained
    // today, but a future refactor that changes the default to e.g.
    // `XDG_CACHE_HOME/spec/<hash>.sqlite` would silently leak the
    // containment invariant with no test to catch it. Same change mirrored
    // in commands/serve.ts.
    if (outArg) assertContainedPath(dbPath, platformDir, "spec resolve: --out");

    const normalized = normalizeFileInputs(files, platformDir);

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
      const rows = storage.resolveByFiles(normalized);
      // RED-11: distinguish "no requirement tagged in these files" (a normal
      // empty result) from "this platform has no requirements at all" (a
      // brand-new platform that deserves first-spec guidance). Text mode
      // only — JSON consumers depend on "[]" on stdout. Still exit 0.
      if (!args.json && rows.length === 0 && storage.listRequirements().length === 0) {
        console.error(formatNoRequirementsIndexed(platformDir));
        return;
      }
      const output = renderResolve(rows, args.json ? "json" : "text");
      console.log(output);
    });
    // Read-only command: exit 0 unconditionally on success.
  },
});
